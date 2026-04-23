import assert from 'node:assert/strict'
import { updateOpfMetadata } from '../src/translator-workbench.js'

const ORIGINAL_OPF = `<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="p9781324075974" version="3.0" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>The Optimist</dc:title>
<dc:creator>Keach Hagey</dc:creator>
<dc:identifier id="p9781324075974">9781324075974</dc:identifier>
<dc:source>9781324075967</dc:source>
<dc:date>2025-04-18</dc:date>
<dc:type>Text</dc:type>
<dc:format>366 Pages</dc:format>
<dc:language>en</dc:language>
<dc:publisher>W. W. Norton &amp; Company</dc:publisher>
<dc:rights>Copyright © 2025 by Keach Hagey</dc:rights>
<meta property="dcterms:modified">2025-04-18T20:00:00Z</meta>
<meta content="cover-image" name="cover"/>
</metadata>
</package>`

const BROKEN_OPF = `<package unique-identifier="p9781324075974" version="3.0" lang="en">
  <metadata title="The Optimist" creator="Keach Hagey" source="9781324075967" date="2025-04-18" type="Text" format="366 Pages" language="cs" publisher="W. W. Norton &amp; Company" rights="Copyright © 2025 by Keach Hagey" description="Blurb">
    <identifier id="p9781324075974">9781324075974</identifier>
    <meta property="dcterms:modified">2025-04-18T20:00:00Z</meta>
    <meta content="cover-image" name="cover"></meta>
  </metadata>
</package>`

function run() {
  const fixedOriginal = updateOpfMetadata(ORIGINAL_OPF, 'cs', { modifiedAt: '2026-04-15T12:00:00Z' })
  assert.match(fixedOriginal, /<package\b[^>]*xmlns="http:\/\/www\.idpf\.org\/2007\/opf"/i)
  assert.match(fixedOriginal, /<package\b[^>]*xml:lang="cs"/i)
  assert.match(fixedOriginal, /<dc:language>cs<\/dc:language>/i)
  assert.match(fixedOriginal, /<dc:title>The Optimist<\/dc:title>/i)
  assert.match(fixedOriginal, /<dc:creator>Keach Hagey<\/dc:creator>/i)
  assert.match(fixedOriginal, /<dc:identifier id="p9781324075974">9781324075974<\/dc:identifier>/i)
  assert.match(fixedOriginal, /<meta\b[^>]*property="dcterms:modified"[^>]*>2026-04-15T12:00:00Z<\/meta>/i)
  assert.match(fixedOriginal, /<meta\b(?=[^>]*\bname="cover")(?=[^>]*\bcontent="cover-image")[^>]*\/?>/i)
  assert.doesNotMatch(fixedOriginal, /<metadata\b[^>]*\btitle="/i)

  const repairedBroken = updateOpfMetadata(BROKEN_OPF, 'cs', { modifiedAt: '2026-04-15T12:00:00Z' })
  assert.match(repairedBroken, /<package\b[^>]*xmlns="http:\/\/www\.idpf\.org\/2007\/opf"/i)
  assert.match(repairedBroken, /<package\b[^>]*xml:lang="cs"/i)
  assert.doesNotMatch(repairedBroken, /<package\b[^>]*\s(?<!xml:)lang="/i)
  assert.match(repairedBroken, /<metadata\b[^>]*xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/"/i)
  assert.match(repairedBroken, /<dc:title>The Optimist<\/dc:title>/i)
  assert.match(repairedBroken, /<dc:creator>Keach Hagey<\/dc:creator>/i)
  assert.match(repairedBroken, /<dc:identifier id="p9781324075974">9781324075974<\/dc:identifier>/i)
  assert.match(repairedBroken, /<dc:source>9781324075967<\/dc:source>/i)
  assert.match(repairedBroken, /<dc:language>cs<\/dc:language>/i)
  assert.match(repairedBroken, /<dc:publisher>W\. W\. Norton &amp; Company<\/dc:publisher>/i)
  assert.match(repairedBroken, /<dc:rights>Copyright © 2025 by Keach Hagey<\/dc:rights>/i)
  assert.match(repairedBroken, /<dc:description>Blurb<\/dc:description>/i)
  assert.match(repairedBroken, /<meta\b[^>]*property="dcterms:modified"[^>]*>2026-04-15T12:00:00Z<\/meta>/i)
  assert.doesNotMatch(repairedBroken, /<metadata\b[^>]*\btitle="/i)
  assert.doesNotMatch(repairedBroken, /<metadata\b[^>]*\bcreator="/i)
  assert.doesNotMatch(repairedBroken, /<identifier\b/i)

  console.log(JSON.stringify({ ok: true, checked: 2 }, null, 2))
}

run()
