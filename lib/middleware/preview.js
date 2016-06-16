'use strict';
const path = require('path');
/*
 * This will create a middleware called "mail.preview" that will enable you
 * to preview html in development mode.
 * NOTE:
 *   this is only created in DEVELOPMENT mode.
 * */
module.exports = function(thorin, opt, pluginObj) {
  const logger = thorin.logger(opt.logger);
  if (thorin.env !== 'development') return;
  const dispatcher = thorin.dispatcher;

  dispatcher
    .addMiddleware('mail.preview')
    .input({
      template: dispatcher.validate('STRING').error('MAIL.INVALID_TEMPLATE', 'Invalid or missing preview template path.')
    })
    .use((intentObj, next) => {
      let templatePath = intentObj.input('template');
      templatePath = templatePath.replace(/\.\./g,'');
      templatePath = path.normalize(templatePath);
      pluginObj
        .prepare(templatePath, intentObj.rawInput)
        .then((html) => {
          intentObj.rawResult(html);
          next();
        }).catch(next);
    });

}