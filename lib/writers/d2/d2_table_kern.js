'use strict';


const u = require('../../utils');
const { BitStream } = require('bit-buffer');
const Kern = require('../../font/table_kern');

/* Two fields share 4 bytes */
const O_PAIR_CNT = 0;                     //BIT0-29
const O_GLYPH_IDS_SIZE = O_PAIR_CNT + 0;  //BIT30-31

const O_GLYPH_ID_MAX = O_GLYPH_IDS_SIZE + 4;
const CMAP_LENGTH = O_GLYPH_ID_MAX + 4;

class LvKern extends Kern {
  constructor(font) {
    super(font);

    this.lv_compiled = false;
    this.gid_max = 0;
    this.baseOffset = 0;
    this.Kern_buf = Buffer.alloc(0);
  }

  lv_compile() {
    if (this.lv_compiled) return;
    this.lv_compiled = true;

    this.font.glyphIdFormat = 0;
    let kern_pairs = this.collect_format0_data();
    kern_pairs.forEach(pair => {
      let gid_max = pair[0];
      if (gid_max < pair[1]) {
        gid_max = pair[1];
      }
      if (gid_max > 255) {
        this.font.glyphIdFormat = 1;
      }
      if (this.gid_max < gid_max) {
        this.gid_max = gid_max;
      }
    });
  }

  to_lv_format0() {
    this.lv_compile();

    const f = this.font;
    let kern_pairs = this.collect_format0_data();

    return `
/*-----------------
 *    KERNING
 *----------------*/

struct __attribute__((packed)) d2_font_fmt_txt_kern_pair_ext {
    /*Collect the kern pair's data in one place*/
    d2_font_fmt_txt_kern_pair_t kern_pairs;
    /* Kerning between the respective left and right glyphs
     * 4.4 format which needs to scaled with \`kern_scale\`*/
    int8_t values[${kern_pairs.length}];
    /*Pair left and right glyphs for kerning*/
    ${f.glyphIdFormat ? 'uint16_t' : 'uint8_t'} glyph_ids[${kern_pairs.length * 2}];
};

static const struct d2_font_fmt_txt_kern_pair_ext kern_pairs_ext = {
    .kern_pairs = {
        .pair_cnt = ${kern_pairs.length},
        .glyph_ids_size = ${f.glyphIdFormat},
        .glyph_id_max = ${this.gid_max}
    },
    .values = {
${u.long_dump(kern_pairs.map(pair => f.kernToFP(pair[2])), { indent: 8 })}    
    },
    .glyph_ids = {
${kern_pairs.map(pair => `        ${pair[0]}, ${pair[1]}`).join(',\n')}
    }
};

`.trim();
  }

  toD2() {
    const f = this.font;

    if (!f.hasKerning()) return '';

    return this.to_lv_format0();
  }

  setFmtTxtKernOffset(offset) {
    this.baseOffset = offset + 4;
  }

  getFmtTxtKernOffset() {
    return this.baseOffset;
  }

  getFmtTxtKernLength() {
    this.lv_compile();
    if (this.Kern_buf.length > 0) {
      return this.Kern_buf.length;
    }

    const f = this.font;

    let total_length = 0;

    if (!f.hasKerning()) return 0;

    total_length = 4 + CMAP_LENGTH;
    let kern_pairs = this.collect_format0_data();
    if (this.font.glyphIdFormat === 0) {
      total_length += kern_pairs.length * (1 + 2 * 1);
    } else {
      total_length += kern_pairs.length * (1 + 2 * 2);
    }
    total_length = u.align4(total_length);

    const buf = Buffer.alloc(total_length);
    buf.write('KERN', 0);
    let buf_temp = Buffer.alloc(4);

    const bs = new BitStream(buf_temp);
    bs.writeBits(kern_pairs.length, 30);
    bs.writeBits(this.font.glyphIdFormat, 2);
    buf.set(buf_temp, 4 + O_PAIR_CNT);
    buf.writeUInt32LE(this.gid_max, 4 + O_GLYPH_ID_MAX);

    for (let index = 0; index < kern_pairs.length; index++) {
      const pair = kern_pairs[index];
      buf.writeInt8(f.kernToFP(pair[2]), 4 + CMAP_LENGTH + index);
      if (this.font.glyphIdFormat === 0) {
        buf.writeUInt8(pair[0], 4 + CMAP_LENGTH + kern_pairs.length + index * 2);
        buf.writeUInt8(pair[1], 4 + CMAP_LENGTH + kern_pairs.length + index * 2 + 1);
      } else {
        buf.writeUInt16LE(pair[0], 4 + CMAP_LENGTH + kern_pairs.length + index * 4);
        buf.writeUInt16LE(pair[1], 4 + CMAP_LENGTH + kern_pairs.length + index * 4 + 2);
      }
    }

    this.Kern_buf = buf;
    return total_length;
  }

  getFmtTxtKern() {
    this.getFmtTxtKernLength();
    return this.Kern_buf;
  }
}


module.exports = LvKern;
