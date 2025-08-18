// Write font in binary format
'use strict';


const AppError = require('../app_error');
const Font     = require('./d2/d2_font');


module.exports = function write_images(args, fontData) {
  if (!args.output) throw new AppError('Output is required for "d2bin" writer');

  const font = new Font(fontData, args);

  return {
    [args.output]: font.toD2Bin()
  };
};
