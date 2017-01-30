'use strict';
const path = require('path'),
  fs = require('fs'),
  extractText = require('html-to-text'),
  cheerio = require('cheerio'),
  juice = require('juice');
/**
 * The mail plugin wraps itself over the nodemailer node.js module and uses its clients.
 *
 * This plugin also offers the following middleware:
 *    "mail#preview" -> preview an e-mail template.
 * */
const loadTransports = require('./lib/loader'),
  loadMiddleware = require('./lib/middleware/preview'),
  TEMPLATE_CACHE = {},  // used to cache plain HTML templates when not using rendering and in production.
  CSS_CACHE = {};       // used to cache inline CSS content for when in production.
module.exports = function (thorin, opt, pluginName) {
  opt = thorin.util.extend({
    logger: 'mail',
    transport: [],     // array of transports to use. If sent as strings, we will do a require() for the modules, otherwise, we will consider the actual object as the transport.
    options: {},         // a hash of {transportKey:{transportOptions}}. NOTE: if we have ONLY ONE TRANPORT, we will use the direct options object.
    from: null,          // generic from address
    templates: "app/emails",  // the template path, relative to thorin's root folder.
    render: "render",      // the thorin-plugin-render pluginName, to use to render templates. If not present, will fall to plain file loading.
    enabled: true          // turning this to false will just simulate email sending.
  }, opt);
  if (typeof opt.templates === 'string') {
    opt.templates = path.normalize(thorin.root + '/' + opt.templates);
  }
  const logger = thorin.logger(opt.logger);
  const pluginObj = {};
  loadTransports(thorin, opt, pluginObj);  // load transports
  if (opt.transport.length === 0) {
    logger.fatal(`No valid mailing transports have been registered.`);
  }

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
   *               - OR an object with {code: string, options: object} and we'll create a new transport every time.
   * */
  pluginObj.send = function SendEmail(sendOpt, _variables) {
    sendOpt = thorin.util.extend({
      to: null,
      from: opt.from,
      from_name: null,
      subject: null,
      html: null,
      text: true,
      template: null,
      replyTo: null,
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
      let transportObj,
        mailerObj,
        transportOpt;
      if (typeof sendOpt.transport === 'object' && sendOpt.transport) {
        // we create a new transport here, with the given options
        transportObj = pluginObj.createTransport(sendOpt.transport.code, sendOpt.transport.options);
        transportOpt = sendOpt.transport.options;
        if (transportObj) mailerObj = transportObj;
      } else {
        transportObj = getTransport(sendOpt.transport);
        if (transportObj) {
          transportOpt = transportObj.options;
          mailerObj = transportObj.mailer;
        }
      }
      if (!transportObj) {
        return reject(thorin.error('MAIL.DATA', 'Invalid or missing mail transport', 400));
      }
      delete sendOpt.transport;
      if (!sendOpt.from) {
        sendOpt.from = transportOpt.from || opt.from;
      }
      if (!sendOpt.from) {
        return reject(thorin.error('MAIL.DATA', 'Invalid or missing from e-mail', 400));
      }
      if (sendOpt.from_name) {
        sendOpt.from = sendOpt.from_name + '<' + sendOpt.from + '>';
        delete sendOpt.from_name;
      }
      let calls = [],
        templateName = null;
      /* step one, check if we have to render anything. */
      if (sendOpt.template) {
        sendOpt.html = null;
        calls.push(() => {
          return pluginObj.prepare(sendOpt, _variables).then((html) => {
            sendOpt.html = html
            templateName = sendOpt.template;
            delete sendOpt.template;
          });
        });
      }

      // Check if we have to extract text.
      if (sendOpt.text === true) {
        calls.push(() => {
          const text = extractText.fromString(sendOpt.html, {
            wordwrap: 100,
            ignoreImage: true
          });
          if (typeof text === 'string' && text) {
            sendOpt.text = text;
          } else {
            sendOpt.text = '';
          }
        });
      }

      thorin.series(calls, (err) => {
        if (err) {
          return reject(thorin.error(err));
        }
        if (!opt.enabled) {
          logger.trace(`Mock email [${templateName || 'raw'}] to [${sendOpt.to}] with subject: ${sendOpt.subject}`);
          if (_variables) {
            logger.trace(_variables);
          }
          return resolve();
        }
        if (sendOpt.html === '' && sendOpt.text === '') {
          return reject(thorin.error('MAIL.SEND', 'Mail content is empty.', 400));
        }
        delete sendOpt.template;
        /* MAILGUN has replyTo under h:Reply-To */
        if (sendOpt.replyTo) {
          sendOpt['h:Reply-To'] = sendOpt.replyTo;
        }
        // At this point, try to send it with our client.
        mailerObj.sendMail(sendOpt, (err, res) => {
          if (err) {
            return reject(thorin.error('MAIL.SEND', 'Could not deliver e-mail', err));
          }
          resolve(res);
        });
      });
    });
  };

  /*
   * Prepares the given HTML or template, to be rendered, styled and parsed.
   * OPTIONS:
   *   - html {string} - the actual HTML to be prepared
   *      OR
   *  - template {string} - the template path to use in stead of custon HTML
   *  - variables {object} - an object of variables that will be used while rendering, if using a rendering engine.
   * */
  pluginObj.prepare = function PrepareHTML(prepareOpt, _variables, _includeRenderGlobals) {
    if (typeof prepareOpt === 'string') {
      prepareOpt = {
        template: prepareOpt
      };
    } else {
      prepareOpt = thorin.util.extend({
        html: null,
        template: null
      }, prepareOpt);
    }
    return new Promise((resolve, reject) => {
      if (!prepareOpt.html && !prepareOpt.template) {
        return reject(thorin.error('MAIL.TEMPLATE', 'Missing mail html or template', 400));
      }
      let calls = [],
        html = null;
      if (prepareOpt.template) {
        const templatePath = (path.isAbsolute(prepareOpt.template) ? prepareOpt.template : path.normalize(opt.templates + '/' + prepareOpt.template));
        calls.push(() => {
          // Check if we have the rendering engine installed.
          const renderObj = thorin.plugin(opt.render);
          if (!renderObj) return;
          return new Promise((resolve, reject) => {
            renderObj.render(templatePath, _variables || {}, (err, thtml) => {
              if (err) {
                logger.warn(`Failed to render template ${templatePath}`, err);
                return reject(thorin.error('MAIL.TEMPLATE', 'Could not render template content', err));
              }
              html = thtml;
              resolve();
            }, _includeRenderGlobals);
          });
        });
        // Check if we still have no html, then we will just fs.readFile.
        calls.push(() => {
          if (html) return;
          if (thorin.env === 'production' && TEMPLATE_CACHE[templatePath]) {
            html = TEMPLATE_CACHE[templatePath];
            return;
          }
          return new Promise((resolve, reject) => {
            fs.readFile(templatePath, {encoding: 'utf8'}, (err, thtml) => {
              if (err) {
                logger.warn(`Could not read from mail template: ${templatePath}`, err);
                return reject(thorin.error('MAIL.TEMPLATE', 'Could not read template content', 500));
              }
              html = thtml;
              if (thorin.env === 'production') {
                TEMPLATE_CACHE[templatePath] = thtml;
              }
              resolve();
            });
          });
        });
      } else {
        html = prepareOpt.html;
      }

      /* IF we have HTML, extract any <links> and insert them with <style> */
      calls.push(() => {
        if (!html) return;
        const $ = cheerio.load(html);
        let links = $("link[href]"),
          toDownload = [];
        // remove any scripts
        $("script").remove();
        if (links.length === 0) {
          html = $.html();
          return;
        }
        links.each((idx, $link) => {
          try {
            let linkUrl = $link.attribs.href;
            if (!linkUrl || linkUrl.indexOf('.css') === -1) return;
            toDownload.push(linkUrl);
          } catch (e) {
          }
        });
        links.replaceWith("");  // remove any links.
        const $head = $("head");
        // download every css resource.
        const downloads = [];
        toDownload.forEach((cssUrl) => {
          if (thorin.env === 'production' && typeof CSS_CACHE[cssUrl] === 'string') {
            $head.append("<style type='text/css'>\n" + CSS_CACHE[cssUrl] + "\n</style>");
            return;
          }
          downloads.push((done) => {
            if (!opt.enabled) return done();
            thorin.util.downloadFile(cssUrl, (err, cssData) => {
              if (err) {
                logger.warn(`Could not download css content from: ${cssUrl}`, err);
                return done();
              }
              $head.append("<style type='text/css'>\n" + cssData + "\n</style>");
              if (thorin.env === 'production') {
                CSS_CACHE[cssUrl] = cssData;
              }
              done();
            });
          });
        });
        return new Promise((resolve) => {
          thorin.util.async.parallel(downloads, () => {
            html = $.html();
            resolve();
          });
        });
      });

      /* finally, use juice to place <styles> in the style attributes */
      calls.push(() => {
        if (!html) return;
        html = juice(html, {
          inlinePseudoElements: false,
          removeStyleTags: false
        });
      });

      thorin.series(calls, (err) => {
        if (err) return reject(err);
        resolve(html);
      });
    });
  }
  /* insert our preview middleware */
  loadMiddleware(thorin, opt, pluginObj);

  /* The setup function will setup the templates path */
  pluginObj.setup = function DoSetup(done) {
    if (!opt.templates) return done();
    try {
      thorin.util.fs.ensureDirSync(path.normalize(opt.templates));
    } catch (e) {
    }
    done();
  }

  return pluginObj;
}
module.exports.publicName = 'mail';