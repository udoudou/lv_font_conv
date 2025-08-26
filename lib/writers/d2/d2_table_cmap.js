'use strict';


const u = require('../../utils');
const debug = require('debug')('cmap');
const { BitStream } = require('bit-buffer');
const build_subtables = require('../../font/cmap_build_subtables');
const Cmap = require('../../font/table_cmap');

const O_RANGE_START = 0;
const O_RANGE_LENGTH = O_RANGE_START + 4;
const O_GLYPH_ID_START = O_RANGE_LENGTH + 2;
/* Two fields share 4 bytes */
const O_GLYPH_BITMAP_INDEX_BASE = O_GLYPH_ID_START + 2;  //BIT0-29
const O_TYPE = O_GLYPH_BITMAP_INDEX_BASE + 0;            //BIT30-31

const O_UNICODE_LIST = O_TYPE + 4;
const O_GLYPH_ID_OFS_LIST = O_UNICODE_LIST + 4;
const O_LIST_LENGTH = O_GLYPH_ID_OFS_LIST + 4;
const CMAP_LENGTH = O_LIST_LENGTH + 2;


class LvCmap extends Cmap {
  constructor(font) {
    super(font);

    this.lv_compiled = false;
    this.lv_subtables = [];
    this.baseOffset = 0;
  }

  lv_format2enum(name) {
    switch (name) {
      case 'format0_tiny': return 'D2_FONT_FMT_TXT_CMAP_FORMAT0_TINY';
      case 'format0': return 'D2_FONT_FMT_TXT_CMAP_FORMAT0_FULL';
      case 'sparse_tiny': return 'D2_FONT_FMT_TXT_CMAP_SPARSE_TINY';
      case 'sparse': return 'D2_FONT_FMT_TXT_CMAP_SPARSE_FULL';
      default: throw new Error('Unknown subtable format');
    }
  }

  lv_format2num(name) {
    switch (name) {
      case 'format0': return 0;
      case 'sparse': return 1;
      case 'format0_tiny': return 2;
      case 'sparse_tiny': return 3;
      default: throw new Error('Unknown subtable format');
    }
  }

  lv_compile() {
    if (this.lv_compiled) return;
    this.lv_compiled = true;

    const f = this.font;

    let subtables_plan = build_subtables(f.src.glyphs.map(g => g.code));
    let idx = 0;
    f.glyf.lv_compile();

    for (let index = 0; index < subtables_plan.length; index++) {
      const subtable = subtables_plan[index];
      let format = subtable[0];
      let codepoints = subtable[1];

      let min_code = codepoints[0];
      let max_code = codepoints[codepoints.length - 1];
      let start_glyph_id = f.glyph_id[min_code];
      let bitmap_index_base = f.glyf.lv_data[start_glyph_id].offset;

      if (format === 'format0_tiny') {
        codepoints = [];
        max_code = min_code - 1;
        let index_temp = index;
        for (; index_temp < subtables_plan.length; index_temp++) {
          const subtable_temp = subtables_plan[index_temp];
          let format_temp = subtable_temp[0];
          let codepoints_temp = subtable_temp[1];
          if (format_temp !== 'format0_tiny') {
            break;
          }
          if (max_code + 1 !== codepoints_temp[0]) {
            break;
          }

          let code_index_temp = 0;
          let new_offset = 0;
          let max_offset = 2 ** 21; //bitmap_index is only 21 bits
          for (; code_index_temp < codepoints_temp.length; code_index_temp++) {
            let code_temp = codepoints_temp[code_index_temp];
            let glyph_id = f.glyph_id[code_temp];
            new_offset = f.glyf.lv_data[glyph_id].offset - bitmap_index_base;
            if (new_offset >= max_offset) {
              subtables_plan[index_temp][1] = codepoints_temp.slice(code_index_temp, codepoints_temp.length);
              break;
            }
            codepoints.push(code_temp);
            max_code = code_temp;
            f.glyf.lv_data[glyph_id].offset = new_offset;
          }
          if (new_offset >= max_offset) {
            break;
          }
        }
        index = index_temp - 1;
      } else {
        for (let code of codepoints) {
          let glyph_id = f.glyph_id[code];
          f.glyf.lv_data[glyph_id].offset -= bitmap_index_base;
        }
      }

      let has_charcodes = false;
      let has_ids = false;
      let defs = '';
      let entries_count = 0;

      let buf_charcodes = Buffer.alloc(0);
      let buf_ids = Buffer.alloc(0);

      if (format === 'format0_tiny') {
        // use default empty values
      } else if (format === 'format0') {
        has_ids = true;
        let d = this.collect_format0_data(min_code, max_code, start_glyph_id);
        entries_count = d.length;

        defs = `
static const uint8_t glyph_id_ofs_list_${idx}[] = {
${u.long_dump(d)}
};
`.trim();

        buf_ids = Buffer.alloc(entries_count);
        for (let index = 0; index < entries_count; index++) {
          const id_offset = d[index];
          buf_ids.writeUInt8(id_offset, index);
        }
      } else if (format === 'sparse_tiny') {
        has_charcodes = true;
        let d = this.collect_sparse_data(codepoints, start_glyph_id);
        entries_count = d.codes.length;

        defs = `
static const uint16_t unicode_list_${idx}[] = {
${u.long_dump(d.codes, { hex: true })}
};
`.trim();
        buf_charcodes = Buffer.alloc(entries_count * 2);
        for (let index = 0; index < entries_count; index++) {
          const unicode = d.codes[index];
          buf_charcodes.writeUInt16LE(unicode, index * 2);
        }
      } else { // assume format === 'sparse'
        has_charcodes = true;
        has_ids = true;
        let d = this.collect_sparse_data(codepoints, start_glyph_id);
        entries_count = d.codes.length;

        defs = `
static const uint16_t unicode_list_${idx}[] = {
${u.long_dump(d.codes, { hex: true })}
};
static const uint16_t glyph_id_ofs_list_${idx}[] = {
${u.long_dump(d.ids)}
};
`.trim();
        buf_charcodes = Buffer.alloc(entries_count * 2);
        buf_ids = Buffer.alloc(entries_count * 2);
        for (let index = 0; index < entries_count; index++) {
          const unicode = d.codes[index];
          const id_offset = d.ids[index];
          buf_charcodes.writeUInt16LE(unicode, index * 2);
          buf_ids.writeUInt16LE(id_offset, index * 2);
        }
      }

      const u_list = has_charcodes ? `unicode_list_${idx}` : 'NULL';
      const id_list = has_ids ? `glyph_id_ofs_list_${idx}` : 'NULL';

      /* eslint-disable max-len */
      const head = `    {
        .range_start = ${min_code}, .range_length = ${max_code - min_code + 1}, .glyph_id_start = ${start_glyph_id}, .glyph_bitmap_index_base = ${bitmap_index_base},
        .type = ${this.lv_format2enum(format)}, .unicode_list = ${u_list}, .glyph_id_ofs_list = ${id_list}, .list_length = ${entries_count},
    }`;

      const buf_cmap = Buffer.alloc(CMAP_LENGTH);
      buf_cmap.writeUInt32LE(min_code, O_RANGE_START);
      buf_cmap.writeUInt32LE(max_code - min_code + 1, O_RANGE_LENGTH);
      buf_cmap.writeUInt16LE(start_glyph_id, O_GLYPH_ID_START);
      let buf_temp = Buffer.alloc(4);
      const bs = new BitStream(buf_temp);
      bs.writeBits(bitmap_index_base, 30);
      bs.writeBits(this.lv_format2num(format), 2);
      buf_cmap.set(buf_temp, O_GLYPH_BITMAP_INDEX_BASE);

      /* Update the correct offset when generating data later */
      // buf_cmap.writeUInt32LE(has_charcodes, O_UNICODE_LIST);
      // buf_cmap.writeUInt32LE(has_ids, O_GLYPH_ID_OFS_LIST);
      buf_cmap.writeUInt16LE(entries_count, O_LIST_LENGTH);

      this.lv_subtables.push({
        defs,
        head,
        buf_cmap,
        buf_charcodes,
        buf_ids
      });

      idx++;
    }
  }

  toD2() {
    this.lv_compile();

    return `
/*---------------------
 *  CHARACTER MAPPING
 *--------------------*/

${this.lv_subtables.map(d => d.defs).filter(Boolean).join('\n\n')}

/*Collect the unicode lists and glyph_id offsets*/
static const d2_font_fmt_txt_cmap_t cmaps[] =
{
${this.lv_subtables.map(d => d.head).join(',\n')}
};
 `.trim();
  }

  setFmtTxtCmapOffset(offset) {
    this.baseOffset = offset + 4;
  }

  getFmtTxtCmapOffset() {
    return this.baseOffset;
  }

  getFmtTxtCmapLength() {
    this.lv_compile();

    let total_length = 4;
    total_length += CMAP_LENGTH * this.lv_subtables.length;
    this.lv_subtables.forEach(d => {
      const buf_charcodes = d.buf_charcodes;
      const buf_ids = d.buf_ids;
      total_length += (buf_charcodes.length + buf_ids.length);
    });
    total_length = u.align4(total_length);
    return total_length;
  }

  getFmtTxtCmap() {
    const buf = Buffer.alloc(this.getFmtTxtCmapLength());
    buf.write('CMAP', 0);

    let offset = CMAP_LENGTH * this.lv_subtables.length;
    this.lv_subtables.forEach((d, idx) => {
      const buf_cmap = d.buf_cmap;
      const buf_charcodes = d.buf_charcodes;
      const buf_ids = d.buf_ids;

      if (buf_charcodes.length > 0) {
        buf.set(buf_charcodes, 4 + offset);
        buf_cmap.writeUInt32LE(this.baseOffset + offset, O_UNICODE_LIST);
        offset += buf_charcodes.length;
      }
      if (buf_ids.length > 0) {
        buf.set(buf_ids, 4 + offset);
        buf_cmap.writeUInt32LE(this.baseOffset + offset, O_GLYPH_ID_OFS_LIST);
        offset += buf_charcodes.length;
      }
      buf.set(buf_cmap, 4 + CMAP_LENGTH * idx);
    });
    debug(`fmt_txt_cmap table size = ${buf.length}`);
    return buf;
  }
}


module.exports = LvCmap;
