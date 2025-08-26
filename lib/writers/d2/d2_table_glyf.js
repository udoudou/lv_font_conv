'use strict';


const { BitStream } = require('bit-buffer');
const u = require('../../utils');
const Glyf = require('../../font/table_glyf');
const AppError = require('../../app_error');

/* Two fields share 4 bytes */
const O_BITMAP_INDEX_OFFSET = 0;                //BIT0-20
const O_DSC_INDEX = O_BITMAP_INDEX_OFFSET + 0;  //BIT21-31

const FMTTXTGLYPHINDEX_LENGTH = O_DSC_INDEX + 4;


const O_ADV_W = 0;
const O_BOX_W = O_ADV_W + 2;
const O_BOX_H = O_BOX_W + 1;
const O_OFS_X = O_BOX_H + 1;
const O_OFS_Y = O_OFS_X + 1;

const FMTTXTGLYPHDSC_LENGTH = O_OFS_Y + 1;

class LvGlyf extends Glyf {
  constructor(font) {
    super(font);

    this.lv_data = [];
    this.lv_dsc = [];
    this.lv_compiled = false;
    this.glyphIndexOffset = 0;
    this.glyphDscOffset = 0;
    this.bitMapOffset = 0;
    this.bitmap = Buffer.alloc(0);
    this.glyph_index_bin = Buffer.alloc(0);
    this.lv_dsc_bin = Buffer.alloc(0);
  }

  lv_bitmap(glyph) {
    let buf;

    if (this.font.opts.align !== 1 || this.font.opts.stride !== 1) {
      buf = Buffer.alloc(100 + glyph.bbox.width * glyph.bbox.height * 4 * 4);
    } else {
      buf = Buffer.alloc(100 + glyph.bbox.width * glyph.bbox.height * 4);
    }

    const bs = new BitStream(buf);
    bs.bigEndian = true;

    const pixels = this.font.glyf.pixelsToBpp(glyph.pixels);

    this.font.glyf.storePixels(bs, pixels);

    let glyph_bitmap;
    if (this.font.opts.align !== 1) {
      glyph_bitmap = Buffer.alloc(Math.ceil(bs.byteIndex / this.font.opts.align) * this.font.opts.align);
    } else {
      glyph_bitmap = Buffer.alloc(bs.byteIndex);
    }

    buf.copy(glyph_bitmap, 0, 0, bs.byteIndex);

    return glyph_bitmap;
  }

  lv_get_dsc_index(glyph) {
    const adv_w = Math.round(glyph.advanceWidth * 16),
          h = glyph.bbox.height,
          w = glyph.bbox.width,
          x = glyph.bbox.x,
          y = glyph.bbox.y;
    let dsc = `    {.adv_w = ${adv_w}, .box_w = ${w}, .box_h = ${h}, .ofs_x = ${x}, .ofs_y = ${y}}`;
    const index = this.lv_dsc.findIndex(d => d === dsc);

    if (index === -1) {
      this.lv_dsc.push(dsc);
      const dsc_buf = Buffer.alloc(FMTTXTGLYPHDSC_LENGTH);
      dsc_buf.writeUInt16LE(adv_w, O_ADV_W);
      dsc_buf.writeUInt8(w, O_BOX_W);
      dsc_buf.writeUInt8(h, O_BOX_H);
      dsc_buf.writeInt8(x, O_OFS_X);
      dsc_buf.writeInt8(y, O_OFS_Y);
      this.lv_dsc_bin = Buffer.concat([ this.lv_dsc_bin, dsc_buf ]);
      return this.lv_dsc.length - 1;
    }
    return index;
  }

  lv_compile() {
    if (this.lv_compiled) return;

    this.lv_compiled = true;

    const f = this.font;
    this.lv_data = [];
    let offset = 0;

    let glyph0 = {
      advanceWidth: 0,
      bbox: {
        x: 0,
        y: 0,
        width: 0,
        height: 0
      }
    };
    this.lv_get_dsc_index(glyph0);

    f.src.glyphs.forEach(g => {
      const id = f.glyph_id[g.code];
      const bin = this.lv_bitmap(g);
      this.lv_data[id] = {
        bin,
        offset,
        glyph: g,
        dsc_index: this.lv_get_dsc_index(g)
      };
      offset += bin.length;
    });
  }

  to_lv_bitmaps() {
    this.lv_compile();

    let result = [];
    this.lv_data.forEach((d, idx) => {
      if (idx === 0) return;
      const code_hex = d.glyph.code.toString(16).toUpperCase();
      const code_str = JSON.stringify(String.fromCodePoint(d.glyph.code));

      let txt = `    /* U+${code_hex.padStart(4, '0')} ${code_str} */
${u.long_dump(d.bin, { hex: true })}`;

      if (idx < this.lv_data.length - 1) {
        // skip comma for zero data
        txt += d.bin.length ? ',\n\n' : '\n';
      }

      result.push(txt);
    });

    return result.join('');
  }

  to_lv_glyph_dsc() {
    this.lv_compile();

    /* eslint-disable max-len */
    return this.lv_dsc.join(',\n');
  }

  to_lv_glyph_index() {
    this.lv_compile();

    /* eslint-disable max-len */

    let result = [ '    {.bitmap_index_offset = 0, .dsc_index = 0} /* id = 0 reserved */' ];

    this.lv_data.forEach(d => {
      const idx = d.offset,
            dsc_idx = d.dsc_index;
      result.push(`    {.bitmap_index_offset = ${idx}, .dsc_index = ${dsc_idx}}`);
    });

    return result.join(',\n');
  }


  toD2() {
    return `
/*-----------------
 *    BITMAPS
 *----------------*/

/*Store the image of the glyphs*/
static ${this.font.opts.align !== 1 ? 'LV_ATTRIBUTE_MEM_ALIGN ' : ''}LV_ATTRIBUTE_LARGE_CONST const uint8_t glyph_bitmap[] = {
${this.to_lv_bitmaps()}
};


/*---------------------
 *  GLYPH DESCRIPTION
 *--------------------*/

static const d2_font_fmt_txt_glyph_dsc_t glyph_dsc[] = {
${this.to_lv_glyph_dsc()}
};

static const d2_font_fmt_txt_glyph_index_t glyph_index[] = {
${this.to_lv_glyph_index()}
};
`.trim();
  }

  setFmtTxtGlyphOffset(baseOffset) {
    this.lv_compile();
    this.glyphIndexOffset = baseOffset + 4;
    this.glyphDscOffset = this.glyphIndexOffset + (FMTTXTGLYPHINDEX_LENGTH * this.lv_data.length) + 4;
    this.bitMapOffset = this.glyphDscOffset + (FMTTXTGLYPHDSC_LENGTH * this.lv_dsc.length) + 4;
  }

  getGlyphIndexOffset() {
    return this.glyphIndexOffset;
  }

  getGlyphDscOffset() {
    return this.glyphDscOffset;
  }

  getBitmapOffset() {
    return this.bitMapOffset;
  }

  getFmtTxtGlyphLength() {
    this.lv_compile();

    let total_length;

    if (this.glyph_index_bin.length === 0) {
      this.glyph_index_bin = Buffer.alloc(FMTTXTGLYPHINDEX_LENGTH * this.lv_data.length);
      const dsc_index_temp = Buffer.alloc(FMTTXTGLYPHINDEX_LENGTH);
      const bs = new BitStream(dsc_index_temp);
      bs.writeBits(0, 21);
      bs.writeBits(0, 11);

      this.glyph_index_bin.set(dsc_index_temp, 0);
      this.lv_data.forEach((d, idx) => {
        if (idx === 0) {
          return;
        }
        const bs = new BitStream(dsc_index_temp);
        bs.writeBits(d.offset, 21);
        bs.writeBits(d.dsc_index, 11);
        this.glyph_index_bin.set(dsc_index_temp, FMTTXTGLYPHINDEX_LENGTH * idx);
        this.bitmap = Buffer.concat([ this.bitmap, d.bin ]);
      });
    }
    total_length = 4 + (this.bitMapOffset - this.glyphIndexOffset) + this.bitmap.length;
    total_length = u.align4(total_length);
    return total_length;
  }

  getFmtTxtGlyph() {
    const buf = Buffer.alloc(this.getFmtTxtGlyphLength());
    let offset = 0;
    if (this.glyph_index_bin.length !== FMTTXTGLYPHINDEX_LENGTH * this.lv_data.length) {
      throw new AppError(`dsc_index length error num ${this.lv_data.length}(${this.glyph_index_bin.length})`);
    }
    buf.write('GIDX', offset);
    offset += 4;
    buf.set(this.glyph_index_bin, offset);
    offset += FMTTXTGLYPHINDEX_LENGTH * this.lv_data.length;

    if (this.lv_dsc_bin.length !== FMTTXTGLYPHDSC_LENGTH * this.lv_dsc.length) {
      throw new AppError(`dsc_index length error num ${this.lv_dsc.length}(${this.lv_dsc_bin.length})`);
    }
    buf.write('GDSC', offset);
    offset += 4;
    buf.set(this.lv_dsc_bin, offset);
    offset += (FMTTXTGLYPHDSC_LENGTH * this.lv_dsc.length);

    buf.write('GBIT', offset);
    offset += 4;
    buf.set(this.bitmap, offset);
    return buf;
  }
}


module.exports = LvGlyf;
