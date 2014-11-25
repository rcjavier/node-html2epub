#!/usr/bin/env node

'use strict';

var fs       = require('fs');
var path     = require('path');
var mime     = require('mime');
var cheerio  = require('cheerio');
var archiver = require('archiver');

function parseArgsSync() {
  var params = {
    basedir: process.cwd(),
    identifier: getUUID(),
    charset: 'UTF-8',
    language: 'en',
    format: 'txt',         // ToC output format
    depth: 6,              // ToC depth
    keepAllHeadings: false // ignore headings that have no usable ID/anchor
  };

  var argv = {};
  process.argv.forEach(function(arg) {
    var name = arg.replace(/^--|=.*$/g, '');
    var val = arg.replace(/^.*=/, '') || true;
    argv[name] = val;
  });

  if (argv.config) {
    var content = fs.readFileSync(path.resolve(process.cwd(), argv.config));
    var config = JSON.parse(content);
    for (var k in config) {
      params[k] = config[k];
    }
  }

  for (var key in argv) {
    params[key] = argv[key];
  }

  if (!params.spine || !params.spine.length) {
    params.spine = findFilesSync(params.basedir, /\.x?html?$/);
  }

  return params;
}

function findFilesSync(basedir, filter) {
  var files = [];

  function treeWalkSync(base, dir) {
    dir = path.resolve(base, dir);
    (fs.readdirSync(dir) || []).forEach(function(entry) {
      if (fs.lstatSync(path.resolve(dir, entry)).isDirectory()) {
        treeWalkSync(dir, entry);
      } else if (!filter || filter.test(entry)) {
        files.push(path.relative(basedir, path.resolve(dir, entry)));
      }
    });
  }

  treeWalkSync(basedir, '.');
  return files;
}

function getUUID() {
  // http://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript/2117523#2117523
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}


/**
 * Table of Contents
 *
 * This script generates a table of contents from the headers in a collection
 * of XHTML documents.  Four output formats are supported:
 *  - txt   : quick-and-dirty extraction (default output)
 *  - json  : sharp logical structure
 *  - xhtml : EPUB3 index -- elegant and human-readable
 *  - ncx   : EPUB2 index -- ugly but ensures compatibility
 */

function getHeadingID(elt) {
  var id = '';

  // find a suitable ID for `elt`: if there's no leading text between the
  // current element and the beginning of its parent, the parent ID can be used
  var txt = '';
  while (elt.length && !txt.length) {
    id = elt.attr('id');
    if (id) {
      break;
    }
    var p = elt.prev();
    while (p.length) {
      txt += p.text();
      p = p.prev();
    }
    elt = elt.parent();
  }

  return id;
}

function parseHeadingsSync(basedir, hrefs, keepAllHeadings) {
  var pages = [];

  hrefs.forEach(function(href, i) {
    var headings = [];
    var xhtml = fs.readFileSync(path.resolve(basedir, href));
    var $ = cheerio.load(xhtml, { decodeEntities: false });
    $('h1, h2, h3, h4, h5, h6').each(function(index, element) {
      var elt = $(element);
      var h = {
        level: parseInt(element.tagName.substr(1), 10) - 1,
        title: elt.text().replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ')
      };

      var id = getHeadingID(elt);
      if (id) {
        h.href = href + '#' + id;
      } else if (!index) { // if the first title has no ID, use the page href
        h.href = href;
      }

      if (h.href || keepAllHeadings) {
        headings.push(h);
      }
    });

    pages.push({
      href: href,
      headings: headings
    });
  });

  return pages;
}

function indent(level) {
  var txt = '\n    ';
  for (var i = 0; i < level; i++) {
    txt += '  ';
  }
  return txt;
}

function buildToC_txt(pages, depth) {
  var txt = '';

  pages.forEach(function(page) {
    page.headings.forEach(function(heading) {
      if (heading.level < depth) {
        txt += indent(heading.level) + heading.title;
      }
    });
  });

  return txt + '\n';
}

function buildToC_json(pages, depth, strict) {
  var toc = { children: [] };
  var current = toc;
  var currentLevel = 0;

  pages.forEach(function(page) {
    page.headings.forEach(function(heading) {
      if (heading.level < depth) {
        var t = {
          title: heading.title,
          href: heading.href
        };

        // select the appropriate tree branch if the heading level changes
        if (heading.level < currentLevel) { // retrieve existing parent branch
          current = toc;
          for (var i = 0; i < heading.level; i++) {
            current = current.children[current.children.length - 1];
          }
        } else if (heading.level == currentLevel + 1) { // create a new branch
          current = current.children[current.children.length - 1];
          current.children = [];
        } else if (heading.level > currentLevel + 1) { // create nested branches
          console.error('non-continous heading (h' + (heading.level + 1) + '): ' + heading.title);
          if (strict) {
            t = null; // skip this heading
          } else {
            for (var j = 0; j < (heading.level - currentLevel); j++) {
              if (!current.children.length) {
                current.children.push({});
              }
              current = current.children[current.children.length - 1];
              current.children = [];
            }
          }
        }

        // add heading to ToC tree
        if (t) {
          currentLevel = heading.level;
          current.children.push(t);
        }
      }
    });
  });

  return toc.children;
}

function buildToC_ncx(pages, depth) { // EPUB2
  var $ = cheerio.load('<navMap></navMap>', {
    xmlMode: true,
    decodeEntities: false
  });
  var nav = [$('navMap')];
  var currentLevel = 0;
  var playOrder = 1;

  pages.forEach(function(page) {
    page.headings.forEach(function(heading) {
      if (heading.level < depth) {
        var point = indent(heading.level) +
          '<navPoint id="nav_' + playOrder + '" playOrder="' + playOrder + '">' +
          '<navLabel><text>' + heading.title + '</text></navLabel>' +
          '<content src="' + heading.href + '" />' +
          '</navPoint>';

        if (heading.level <= currentLevel) { // re-use current or parent <navPoint>
          nav[heading.level].append(point);
        } else {                             // create new <navPoint> child
          nav[heading.level] = nav[currentLevel].find('navPoint').last();
          nav[currentLevel].find('navPoint').last().append(point);
        }

        currentLevel = heading.level;
        playOrder++;
      }
    });
  });

  return $.html();
}

function buildToC_xhtml(pages, depth) { // EPUB3
  var $ = cheerio.load('  <nav epub:type="toc"><ol></ol>\n  </nav>', {
    xmlMode: true,
    decodeEntities: false
  });
  var ol = [$('ol')];
  var currentLevel = 0;

  pages.forEach(function(page) {
    page.headings.forEach(function(heading) {
      if (heading.level < depth) {
        var title = heading.href ?
          '<a href="' + heading.href + '">' + heading.title + '</a>' :
          '<span>' + heading.title + '</span>';
        var li = indent(heading.level) + '<li>' + title + '</li>';

        if (heading.level <= currentLevel) { // re-use current or parent <ol>
          ol[heading.level].append(li);
        } else {                             // create new <ol> child
          ol[currentLevel].find('li').last().append('<ol>' + li + '</ol>');
          ol[heading.level] = ol[currentLevel].find('ol').last();
        }

        currentLevel = heading.level;
      }
    });
  });

  return $.html();
}

function buildToC(config, format, pages) {
  var output = '';
  pages = pages ||
    parseHeadingsSync(config.basedir, config.spine, config.keepAllHeadings);

  switch (format || config.format) {
    case 'txt':
      output = buildToC_txt(pages, config.depth);
      break;

    case 'json':
      var toc = buildToC_json(pages, config.depth, config.strict);
      output = JSON.stringify(toc, null, 2);
      break;

    case 'ncx':
      output = '<?xml version="1.0" encoding="' + config.charset + '"?>' +
        '\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
        '\n  <head>' +
        '\n    <meta name="dtb:uid" content="' + config.identifier + '" />' +
        '\n    <meta name="dtb:depth" content="' + config.depth + '" />' +
        '\n  </head>' +
        '\n  <docTitle>' +
        '\n    <text>' + config.title + '</text>' +
        '\n  </docTitle>' +
        '\n  ' + buildToC_ncx(pages, config.depth) +
        '\n</ncx>';
      break;

    case 'xhtml':
      output = '<?xml version="1.0" encoding="' + config.charset + '"?>' +
        '\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
        '\n<head>' +
        '\n  <meta charset="' + config.charset + '" />' +
        '\n  <title>' + config.title + '</title>' +
        '\n  <style type="text/css"> nav ol { list-style-type: none; } </style>' +
        '\n</head>' +
        '\n<body>' +
        '\n' + buildToC_xhtml(pages, config.depth) +
        '\n</body>' +
        '\n</html>';
      break;

    default:
      console.error('unsupported output format: "' + config.format + '"');
  }

  return output;
}


/**
 * EPUB maker
 *
 * This script can also be used to wrap a collection of XHTML documents and
 * their associated resources (see "[[content]" below) in an EPUB archive:
 *
 *   META-INF
 *     container.xml
 *   OPS
 *     content.opf
 *     toc.ncx
 *     toc.xhtml
 *     [[content]]
 *   mimetype
 *
 * This structure can't be modified (yet). The good thing is, it works in all
 * EPUB readers.
 *
 * The `mimetype` and `META-INF/container.xml` files are always auto-generated.
 * The `content.opf`, `toc.ncx` and `toc.xhtml` files are generated if necessary
 * (= they aren't overwritten if they already exist in the base directory).
 */

function zeroPadding(prefix, number, digits) {
  number++;
  var str = number.toString();
  while (str.length < digits) {
    str = '0' + str;
  }
  return prefix + str;
}

function buildOPF_manifest_spine(basedir, spine, generatedFiles) {
  var items = [];
  var ncx = 0;

  var files = findFilesSync(basedir);
  (generatedFiles || []).forEach(function(file) {
    files.push(file);
  });

  var digits = files.length.toString().length;
  files.forEach(function(href, index) {
    var id = '';
    var type = mime.lookup(href);

    if (spine.indexOf(href) >= 0) {
      id = zeroPadding('page_', spine.indexOf(href), digits);
    } else if (type == 'application/x-dtbncx+xml') { // toc.ncx
      id = 'ncx';
      ncx++;
    } else if (type != 'application/oebps-package+xml') { // not content.opf
      id = zeroPadding('res_', index, digits);
    }

    if (id) {
      items.push('<item' +
        ' id="' + id + '"' +
        ' media-type="' + type + '"' +
        ' href="' + href + '"' +
        (href == 'toc.xhtml' ? ' properties="nav"' : '') +
        ' />');
    }
  });

  if (ncx > 1) {
    console.error('several NCX files have been found.');
  }

  var manifest = '\n  <manifest>' +
    '\n    ' + items.sort().join('\n    ') +
    '\n  </manifest>';

  var itemrefs = '\n  <spine' + (ncx == 1 ? ' toc="ncx"' : '') + '>';
  spine.forEach(function(href, index) {
    var idref = zeroPadding('page_', index, digits);
    itemrefs += '\n    <itemref idref="' + idref + '" />';
  });
  itemrefs += '\n  </spine>';

  return manifest + itemrefs;
}

function buildOPF_guide(guide) {
  var txt = '';

  if (guide && guide.length) {
    txt = '\n  <guide>';
    guide.forEach(function(item) {
      txt += '\n    <reference ' +
        'href="' + item.href + '" ' +
        'type="' + item.type + '" ' +
        'title="' + item.title + '" />';
    });
    txt += '\n  </guide>';
  }

  return txt;
}

function buildOPF(config, generatedFiles) {
  var dc = '';
  for (var key in config.dc) {
    dc += '\n    <dc:' + key + '>' + config.dc[key] + '</dc:' + key + '>';
  }

  var opf = '<?xml version="1.0" encoding="' + config.charset + '"?>' +
    '\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uuid">' +
    '\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '\n    <dc:identifier id="uuid">' + config.identifier + '</dc:identifier>' +
    '\n    <dc:title>' + config.title + '</dc:title>' +
    '\n    <dc:language>' + config.language + '</dc:language>' + dc +
    '\n  </metadata>' +
    buildOPF_manifest_spine(config.basedir, config.spine, generatedFiles) +
    buildOPF_guide(config.guide) +
    '\n</package>';

  return opf;
}

function buildContainer(rootfile) {
  rootfile = rootfile || 'OPS/content.opf';
  return '<?xml version="1.0"?>' +
    '\n  <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '\n     <rootfiles>' +
    '\n       <rootfile full-path="' + rootfile + '" media-type="application/oebps-package+xml"/>' +
    '\n     </rootfiles>' +
    '\n  </container>';
}

function makeEPUB(config, outputfile) {
  var rootfile = 'OPS/content.opf';
  var tocEPUB3 = 'OPS/toc.xhtml';
  var tocEPUB2 = 'OPS/toc.ncx';

  function fileExists(filename) {
    return fs.existsSync(path.resolve(config.basedir, filename));
  }

  var output = fs.createWriteStream(outputfile);
  var archive = archiver('zip');

  output.on('close', function () {
    console.log(outputfile + ' - ' + archive.pointer() + ' bytes');
  });

  archive.on('error', function(err) {
    throw err;
  });

  archive.pipe(output);

  // META-INF container
  archive.append('application/epub+zip', { name: 'mimetype' });
  archive.append(buildContainer(), { name: 'META-INF/container.xml' });

  // OPS indexes
  var pages;
  var tocFiles = [];
  if (!fileExists('toc.xhtml')) {
    tocFiles.push('toc.xhtml');
    pages = parseHeadingsSync(config.basedir, config.spine, config.keepAllHeadings);
    archive.append(buildToC(config, 'xhtml', pages), { name: 'OPS/toc.xhtml' });
  }
  if (!fileExists('toc.ncx')) {
    tocFiles.push('toc.ncx');
    pages = pages || parseHeadingsSync(config.basedir, config.spine, config.keepAllHeadings);
    archive.append(buildToC(config, 'ncx', pages), { name: 'OPS/toc.ncx' });
  }
  if (!fileExists('content.opf')) {
    archive.append(buildOPF(config, tocFiles), { name: 'OPS/content.opf' });
  }

  // OPS content
  archive.bulk([
    { expand: true, cwd: config.basedir, src: [ '**' ], dest: 'OPS' }
  ]);

  archive.finalize();
}


/**
 * main
 */

var config = parseArgsSync();
if (config.format == 'epub') {
  makeEPUB(config, 'output.epub');
} else if (config.format == 'opf') {
  console.log(buildOPF(config));
} else {
  console.log(buildToC(config));
}

