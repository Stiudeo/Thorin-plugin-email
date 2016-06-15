'use strict';
const path = require('path'),
  fs = require('fs'),
  extractText = require('html-to-text'),
  cheerio = require('cheerio');
/**
 * The mail plugin wraps itself over the nodemailer node.js module and uses its clients.
 * */
const loadTransports = require('./lib/loader'),
  TEMPLATE_CACHE = {},  // used to cache plain HTML templates when not using rendering and in production.
  CSS_CACHE = {};       // used to cache inline CSS content for when in production.
module.exports = function(thorin, opt, pluginName) {
  opt = thorin.util.extend({
    logger: 'mail',
    transport: [],     // array of transports to use. If sent as strings, we will do a require() for the modules, otherwise, we will consider the actual object as the transport.
    options: {},         // a hash of {transportKey:{transportOptions}}. NOTE: if we have ONLY ONE TRANPORT, we will use the direct options object.
    from: null,          // generic from address
    templates: "app/emails",  // the template path, relative to thorin's root folder.
    render: "render"      // the thorin-plugin-render pluginName, to use to render templates. If not present, will fall to plain file loading.
  }, opt);
  if (typeof opt.templates === 'string') {
    opt.templates = path.normalize(thorin.root + '/' + opt.templates);
  }
  const logger = thorin.logger(opt.logger);
  loadTransports(thorin, opt);  // load transports
  if (opt.transport.length === 0) {
    logger.fatal(`No valid mailing transports have been registered.`);
  }
  const pluginObj = {};
  // private function that will select a target transport based on the given string.
  function getTransport(tCode) {
    if (typeof tCode === 'string') {
      for (let i = 0; i < opt.transport.length; i++) {
        if (opt.transport[i].code === tCode) {
          return opt.transport[i];
        }
      }
    }
    return opt.transport[0];
  }

  /*
   * Send out custom e-mails to the given user. This is equivalent to the php's mail() function, with no fancy stuff.
   * OPTIONS:
   *   - to {string|array} -> a string or array of e-mails to send to
   *   - from {string,email} -> the "from e-mail". If not specified, it will default to the options.from value, or the transport's options.from. If no from value exists, we will reject.
   *   - subject {string} -> the subject of the e-mail.
   *   - html - {string} -> the HTML of the content to send.
   *       OR
   *   - template - {string} -> the template path to use in stead of custom HTML.
   *   - text - {string|boolean} -> if set to string, we'll use it. If set to false, we will not set a text. If set to true, we will extract text from HTML. Defaults to "true"
   *   - transport - {string} - the transport to use. Defaults to the first transport.
   * */
  pluginObj.send = function SendEmail(sendOpt, _variables) {
    sendOpt = thorin.util.extend({
      to: null,
      from: opt.from,
      subject: null,
      html: null,
      text: true,
      template: null,
      transport: null
    }, sendOpt || {});
    if (typeof sendOpt.to === 'string') sendOpt.to = [sendOpt.to];
    return new Promise((resolve, reject) => {
      // Step one, validate the "to" e-mail addresses
      if (!(sendOpt.to instanceof Array)) {
        return reject(thorin.error('MAIL.DATA', 'Missing target e-mail', 400));
      }
      let validTo = [];
      for (let i = 0; i < sendOpt.to.length; i++) {
        let tEmail = thorin.sanitize("EMAIL", sendOpt.to[i]);
        if (!tEmail) continue;
        validTo.push(tEmail);
      }
      if (validTo.length === 0) {
        return reject(thorin.error('MAIL.DATA', 'No valid target e-mails.', 400));
      }
      sendOpt.to = validTo;
      let transportObj = getTransport(sendOpt.transport);
      if (!transportObj) {
        return reject(thorin.error('MAIL.DATA', 'Invalid or missing mail transport', 400));
      }
      delete sendOpt.transport;
      if (!sendOpt.from) sendOpt.from = thorin.sanitize("EMAIL", transportObj.options.from || opt.from);
      if (!sendOpt.from) {
        return reject(thorin.error('MAIL.DATA', 'Invalid or missing from e-mail', 400));
      }
      let calls = [];
      /* step one, check if we have to render anything. */
      if (sendOpt.template) {
        sendOpt.html = null;
        const templatePath = path.normalize(opt.templates + '/' + sendOpt.template);
        delete sendOpt.template;
        calls.push(() => {
          // Check if we have the rendering engine installed.
          const renderObj = thorin.plugin(opt.render);
          if (!renderObj) return;
          return new Promise((resolve, reject) => {
            renderObj.render(templatePath, _variables || {}, (err, html) => {
              if(err) {
                return reject(thorin.error('MAIL.TEMPLATE', 'Could not render template content', 500, {
                  temlplate: sendOpt.template
                }));
              }
              sendOpt.html = html;
              resolve();
            });
          });
        });
        // Check if we still have no html, then we will just fs.readFile.
        calls.push(() => {
          if (sendOpt.html) return;
          if(thorin.env === 'production' && TEMPLATE_CACHE[templatePath]) {
            sendOpt.html = TEMPLATE_CACHE[templatePath];
            return;
          }
          return new Promise((resolve, reject) => {
            fs.readFile(templatePath, {encoding: 'utf8'}, (err, html) => {
              if(err) {
                logger.warn(`Could not read from mail template: ${templatePath}`, err);
                return reject(thorin.error('MAIL.TEMPLATE', 'Could not read template content', 500));
              }
              if(thorin.env === 'production') {
                TEMPLATE_CACHE[templatePath] = html;
              }
              sendOpt.html = html;
              resolve();
            });
          });
        });
      }

      /* IF we have HTML, extract any <links> and insert them with <style> */
      calls.push(() => {
        if(!sendOpt.html) return;
        const $ = cheerio.load(sendOpt.html);
        let links = $("link[href]"),
          toDownload = [];
        if(links.length === 0) return;
        links.each((idx, $link) => {
          try {
            let linkUrl = $link.attribs.href;
            if(!linkUrl || linkUrl.indexOf('.css') === -1) return;
            toDownload.push(linkUrl);
          } catch(e) {
          }
        });
        links.replaceWith("");  // remove any links.
        const $head = $("head");
        // download every css resource.
        const downloads = [];
        toDownload.forEach((cssUrl) => {
          if(thorin.env === 'production' && typeof CSS_CACHE[cssUrl] === 'string') {
            $head.append("<style type='text/css'>\n"+CSS_CACHE[cssUrl]+"\n</style>");
            return;
          }
          downloads.push((done) => {
            thorin.util.downloadFile(cssUrl, (err, cssData) => {
              if(err) {
                logger.warn(`Could not download css content from: ${cssUrl}`, err);
                return done();
              }
              $head.append("<style type='text/css'>\n"+cssData+"\n</style>");
              if(thorin.env === 'production') {
                CSS_CACHE[cssUrl] = cssData;
              }
              done();
            });
          });
        });
        return new Promise((resolve) => {
          thorin.util.async.parallel(downloads, ()  => {
            sendOpt.html = $.html();
            resolve();
          });
        });
      });

      // Check if we have to extract text.
      if(sendOpt.text === true) {
        calls.push(() => {
          const text = extractText.fromString(sendOpt.html, {
            wordwrap: 100,
            ignoreImage: true
          });
          if(typeof text === 'string' && text) {
            sendOpt.text = text;
          }
        });
      }

      thorin.series(calls, (err) => {
        if (err) {
          return reject(thorin.error(err));
        }
        // At this point, try to send it with our client.
        transportObj.mailer.sendMail(sendOpt, (err, res) => {
          if(err) {
            return thorin.error('MAIL.SEND', 'Could not deliver e-mail', err);
          }
          resolve(res);
        });
      });
    });
  }

  return pluginObj;
}
module.exports.publicName = 'mail';