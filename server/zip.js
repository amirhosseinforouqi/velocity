'use strict';

/**
 * A minimal ZIP writer.
 *
 * The platform ships with one runtime dependency on purpose, so bundling a
 * folder of documents is done here rather than by pulling in an archiver.
 * Entries are stored, not deflated: these are PDFs, JPEGs and HEICs, which are
 * already compressed, so deflating them costs CPU on a serverless function to
 * save a percent or two.
 *
 * Only what a broker needs is implemented — no encryption, no ZIP64. The
 * central directory uses the 32-bit fields, so an archive is capped below 4GB;
 * callers enforce their own limit well under that.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date and time, which is what the ZIP header carries. */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Names inside the archive come from client-supplied filenames, so they are
 * sanitized: no absolute paths, no traversal, no separators, no control
 * characters. A crafted name must not be able to write outside the folder a
 * person extracts into.
 */
function safeEntryName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    // A leading dot hides the file; a leading dash is read as a flag by some
    // command-line tools people extract with.
    .replace(/^[.\-\s]+/, '')
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

/**
 * Build a ZIP from [{ name, data, date }].
 *
 * Duplicate names are suffixed rather than silently overwriting each other —
 * two applicants can both submit "scan.pdf", and losing one of them inside an
 * archive is the kind of failure nobody notices until it matters.
 */
function createZip(entries) {
  const chunks = [];
  const central = [];
  const used = new Set();
  let offset = 0;

  entries.forEach((entry, index) => {
    let name = safeEntryName(entry.name, `document-${index + 1}`);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n += 1;
      name = `${stem} (${n})${ext}`;
    }
    used.add(name.toLowerCase());

    const nameBytes = Buffer.from(name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(0x02014b50, 0);
    entryHeader.writeUInt16LE(20, 4);    // version made by
    entryHeader.writeUInt16LE(20, 6);    // version needed
    entryHeader.writeUInt16LE(0x0800, 8);
    entryHeader.writeUInt16LE(0, 10);
    entryHeader.writeUInt16LE(time, 12);
    entryHeader.writeUInt16LE(date, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(data.length, 20);
    entryHeader.writeUInt32LE(data.length, 24);
    entryHeader.writeUInt16LE(nameBytes.length, 28);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  });

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBytes, end]);
}

module.exports = { createZip, crc32, safeEntryName };
