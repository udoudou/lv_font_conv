'use strict';


const path = require('path');

const Font = require('../../font/font');
const Head = require('./d2_table_head');
const Cmap = require('./d2_table_cmap');
const Glyf = require('./d2_table_glyf');
const Kern = require('./d2_table_kern');
const AppError = require('../../app_error');
const crc = require('crc');

class LvFont extends Font {
  constructor(fontData, options) {
    super(fontData, options);

    this.font_name = options.lv_font_name;
    if (!this.font_name) {
      const ext = path.extname(options.output);
      this.font_name = path.basename(options.output, ext);
    }

    if (options.lv_fallback) {
      this.fallback = '&' + options.lv_fallback;
      this.fallback_declaration = 'extern const lv_font_t ' + options.lv_fallback + ';\n';
    } else {
      this.fallback = 'NULL';
      this.fallback_declaration = '';
    }

    if (options.bpp === 3 & options.no_compress) {
      throw new AppError('LVGL supports "--bpp 3" with compression only');
    }

    if (options.byte_align) {
      throw new AppError('D2 don\'t supports "--byte_align"');
    }

    if (options.stride && options.stride !== 1) {
      throw new AppError('D2 don\'t supports "--stride" > 1');
    }

    if (options.fast_kerning) {
      throw new AppError('D2 don\'t supports "--force-fast-kern-format"');
    }
  }

  init_tables() {
    this.head = new Head(this);
    this.glyf = new Glyf(this);
    this.cmap = new Cmap(this);
    this.kern = new Kern(this);

    /*
    Note: The cmap table will adjust some data in the glyf table.
    So before outputting the glyf data, we need to generate the cmap table first to ensure that glyf outputs the adjusted data.
    */
    this.cmap.lv_compile();
  }

  large_format_guard() {
    let guard_required = false;
    let glyphs_bin_size = 0;

    this.glyf.lv_data.forEach(d => {
      glyphs_bin_size += d.bin.length;

      if (d.glyph.bbox.width > 255 ||
          d.glyph.bbox.height > 255 ||
          Math.abs(d.glyph.bbox.x) > 127 ||
          Math.abs(d.glyph.bbox.y) > 127 ||
          Math.round(d.glyph.advanceWidth * 16) > 4096) {
        guard_required = true;
      }
    });

    if (glyphs_bin_size > 1024 * 1024) guard_required = true;

    if (!guard_required) return '';

    return `
#if (LV_FONT_FMT_TXT_LARGE == 0)
#  error "Too large font or glyphs in ${this.font_name.toUpperCase()}. Enable LV_FONT_FMT_TXT_LARGE in lv_conf.h")
#endif
`.trimLeft();
  }

  toD2() {
    let guard_name =  this.font_name.toUpperCase();

    return `/*******************************************************************************
 * Size: ${this.src.size} px
 * Bpp: ${this.opts.bpp}
 * Opts: ${this.opts.opts_string}
 ******************************************************************************/

#include "d2_font_fmt_txt.h"

#ifdef __has_include
    #if __has_include("lvgl.h")
        #ifndef LV_LVGL_H_INCLUDE_SIMPLE
            #define LV_LVGL_H_INCLUDE_SIMPLE
        #endif
    #endif
#endif

#ifdef LV_LVGL_H_INCLUDE_SIMPLE
    #include "lvgl.h"
#else
    #include "${this.opts.lv_include || 'lvgl/lvgl.h'}"
#endif

#ifndef ${guard_name}
#define ${guard_name} 1
#endif

#if ${guard_name}

${this.glyf.toD2()}

${this.cmap.toD2()}

${this.kern.toD2()}

${this.head.toD2()}

#endif /*#if ${guard_name}*/
`;
  }

  toD2Bin() {
    let total_length = 0;
    total_length += this.head.getFmtTxtDscLength();
    this.cmap.setFmtTxtCmapOffset(total_length);
    total_length += this.cmap.getFmtTxtCmapLength();
    this.kern.setFmtTxtKernOffset(total_length);
    total_length += this.kern.getFmtTxtKernLength();
    this.glyf.setFmtTxtGlyphOffset(total_length);
    total_length += this.glyf.getFmtTxtGlyphLength();

    const length_buf = Buffer.alloc(4);
    length_buf.writeUInt32LE(4 + total_length, 0);
    const result = Buffer.concat([
      this.head.toD2Bin(),
      length_buf,
      this.head.getFmtTxtDsc(),
      this.cmap.getFmtTxtCmap(),
      this.kern.getFmtTxtKern(),
      this.glyf.getFmtTxtGlyph(),
      length_buf
    ]);

    //Calculate and update CRC32
    result.writeUInt32LE(crc.crc32(result.subarray(0, result.length - 4)), result.length - 4);

    return result;
  }
}


module.exports = LvFont;
