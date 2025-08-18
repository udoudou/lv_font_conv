'use strict';

const u = require('../../utils');
const { BitStream } = require('bit-buffer');
const Head = require('../../font/table_head');

const O_SIZE = 0;
const O_LABEL = O_SIZE + 2;
const O_VERSION = O_LABEL + 6;
const O_LINE_HEIGHT = O_VERSION + 4;
const O_BASE_LINE = O_LINE_HEIGHT + 4;
const O_SUBPIXELS_MODE = O_BASE_LINE + 4;
const O_UNDERLINE_POSITION = O_SUBPIXELS_MODE + 1;
const O_UNDERLINE_THICKNESS = O_UNDERLINE_POSITION + 1;
const HEAD_LENGTH = u.align4(O_UNDERLINE_THICKNESS + 1);

//FmtTxtDsc
const O_GLYPH_BITMAP = 0;
const O_GLYPH_INDEX = O_GLYPH_BITMAP + 4;
const O_GLYPH_DSC = O_GLYPH_INDEX + 4;
const O_CMAPS = O_GLYPH_DSC + 4;
const O_KERN_DSC = O_CMAPS + 4;
const O_KERN_SCALE = O_KERN_DSC + 4;
/* Four fields share 2 bytes */
const O_CMAP_NUM = O_KERN_SCALE + 2;        //BIT0-8
const O_BPP = O_CMAP_NUM + 0;               //BIT9-12
const O_KERN_CLASSES = O_BPP + 0;           //BIT13
const O_BITMAP_FORMAT = O_KERN_CLASSES + 0; //BIT14-15

const FMTTXTDSC_LENGTH = u.align4(O_BITMAP_FORMAT + 2);

class LvHead extends Head {
  constructor(font) {
    super(font);
    this.label = 'D2FtHd';
    this.version = 0;
  }

  kern_ref() {
    const f = this.font;

    if (!f.hasKerning()) {
      return {
        scale:   '0',
        dsc:     'NULL',
        classes: '0'
      };
    }

    return {
      scale: `${Math.round(f.kerningScale * 16)}`,
      dsc: '&kern_pairs_ext.kern_pairs',
      classes: '0'
    };
  }

  toD2() {
    const f = this.font;
    const kern = this.kern_ref();
    const subpixels = (f.subpixels_mode === 0) ? 'LV_FONT_SUBPX_NONE' :
      (f.subpixels_mode === 1) ? 'LV_FONT_SUBPX_HOR' : 'LV_FONT_SUBPX_VER';

    return `
/*--------------------
 *  ALL CUSTOM DATA
 *--------------------*/

static d2_font_context_t d2_font_context = { 0 };

static const d2_font_fmt_txt_dsc_t font_dsc = {
    .glyph_bitmap = glyph_bitmap,
    .glyph_index = glyph_index,
    .glyph_dsc = glyph_dsc,
    .cmaps = cmaps,
    .kern_dsc = ${kern.dsc},
    .kern_scale = ${kern.scale},
    .cmap_num = ${f.cmap.lv_subtables.length},
    .bpp = ${f.opts.bpp},
    .kern_classes = ${kern.classes},
    .bitmap_format = ${f.glyf.getCompressionCode()}
};

${f.fallback_declaration}

/*-----------------
 *  PUBLIC FONT
 *----------------*/

/*Initialize a public general font descriptor*/
#if LVGL_VERSION_MAJOR >= 8
const lv_font_t ${f.font_name} = {
#else
lv_font_t ${f.font_name} = {
#endif
    .get_glyph_dsc = d2_font_get_glyph_dsc_fmt_txt,    /*Function pointer to get glyph's data*/
    .get_glyph_bitmap = d2_font_get_bitmap_fmt_txt,    /*Function pointer to get glyph's bitmap*/
    .line_height = ${f.src.ascent - f.src.descent},          /*The maximum line height required by the font*/
    .base_line = ${-f.src.descent},             /*Baseline measured from the bottom of the line*/

    .subpx = ${subpixels},

    .underline_position = ${f.src.underlinePosition},
    .underline_thickness = ${f.src.underlineThickness},

#if LV_VERSION_CHECK(9, 3, 0)
    .static_bitmap = 1,        /*Bitmaps are stored as const so they are always static */
#endif

    .dsc = &font_dsc,          /*The custom font data. Will be accessed by \`get_glyph_bitmap/dsc\` */
#if LV_VERSION_CHECK(8, 2, 0) || LVGL_VERSION_MAJOR >= 9
    .fallback = ${f.fallback},
#endif
    .user_data = &d2_font_context,
};
`.trim();
  }

  toD2Bin() {
    const f = this.font;
    const buf = Buffer.alloc(HEAD_LENGTH);

    buf.writeUInt32LE(HEAD_LENGTH, O_SIZE);
    buf.write(this.label, O_LABEL);
    buf.writeUInt32LE(this.version, O_VERSION);
    buf.writeInt32LE(f.src.ascent - f.src.descent, O_LINE_HEIGHT);
    buf.writeInt32LE(-f.src.descent, O_BASE_LINE);
    buf.writeUInt8(f.subpixels_mode, O_SUBPIXELS_MODE);
    buf.writeInt8(f.src.underlinePosition, O_UNDERLINE_POSITION);
    buf.writeInt8(f.src.underlineThickness, O_UNDERLINE_THICKNESS);

    return buf;
  }

  getFmtTxtDscLength() {
    return FMTTXTDSC_LENGTH;
  }

  getFmtTxtDsc() {
    const f = this.font;
    const kern = this.kern_ref();

    const buf = Buffer.alloc(FMTTXTDSC_LENGTH);
    buf.writeUInt32LE(f.glyf.getBitmapOffset(), O_GLYPH_BITMAP);
    buf.writeUInt32LE(f.glyf.getGlyphIndexOffset(), O_GLYPH_INDEX);
    buf.writeUInt32LE(f.glyf.getGlyphDscOffset(), O_GLYPH_DSC);
    buf.writeUInt32LE(f.cmap.getFmtTxtCmapOffset(), O_CMAPS);
    if (f.kern.getFmtTxtKernLength() === 0) {
      buf.writeUInt32LE(0, O_KERN_DSC);
    } else {
      buf.writeUInt32LE(f.kern.getFmtTxtKernOffset(), O_KERN_DSC);
    }
    buf.writeUInt16LE(kern.scale, O_KERN_SCALE);

    let cmap_num = f.cmap.lv_subtables.length;
    let bpp = f.opts.bpp;
    let kern_classes = kern.classes;
    let bitmap_format = f.glyf.getCompressionCode();

    let buf_temp = Buffer.alloc(2);
    const bs = new BitStream(buf_temp);
    bs.writeBits(cmap_num, 9);
    bs.writeBits(bpp, 4);
    bs.writeBits(kern_classes, 1);
    bs.writeBits(bitmap_format, 2);

    buf.writeUInt16LE(buf_temp.readUInt16LE(), O_CMAP_NUM);

    return buf;
  }
}


module.exports = LvHead;
