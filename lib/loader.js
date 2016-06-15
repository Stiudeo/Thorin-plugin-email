'use strict';
/**
 * Load up all our transports, configure them.
 */
const nodemailer = require('nodemailer');
module.exports = function(thorin, opt) {
  const logger = thorin.logger(opt.logger);
  if(typeof opt.transport === 'string') opt.transport = [opt.transport];
  /* Load up and require the transports. */
  for(let i=0; i < opt.transport.length; i++) {
    let trans = opt.transport[i],
      isTransport = false,
      transCode;
    if(typeof trans !== 'string') {
      logger.error(`Transport module "${trans}" must be a nodemailer transport name.`);
      continue;
    }
    transCode = trans;
    /* check if it's in the nodemailer-{name}-transport pattern */
    if(trans.indexOf('nodemailer') === -1) {
      trans = 'nodemailer-' + trans + '-transport';
    }
    try {
      trans = require(trans);
    } catch(e) {
      try {
        trans = require.main.require(trans);
      } catch(e) {
        logger.fatal(`Transport module ${trans} is not installed. Please install it in the project root folder using "npm i --save ${trans}`);
        continue;
      }
    }
    let transportOptions = {};
    if(typeof opt.options[transCode] === 'undefined') {
      transportOptions = opt.options;
      opt.options = {};
    } else {
      transportOptions = opt.options[transCode];
      delete opt.options[transCode];
    }
    const mailerObj = nodemailer.createTransport(trans(transportOptions));
    opt.transport[i] = {
      code: transCode,
      mailer: mailerObj,
      options: transportOptions
    };
  }
}