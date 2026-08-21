import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function loadJsZip() {
  const source = await readFile(new URL("../jszip.min.js", import.meta.url), "utf8");
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    Promise,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    Blob,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
  });
  vm.runInContext(source, context, { filename: "jszip.min.js" });
  return module.exports;
}
export async function makeFixturePptx() {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
  zip.file("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>");
  zip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>");
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>A deliberately long title requiring a human to identify its actual takeaway</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body 2"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>Mixed </a:t></a:r><a:r><a:rPr baseline="30000"/><a:t>formatting</a:t></a:r><a:r><a:rPr/><a:t> remains exactly intact across every run in this deliberately long linked paragraph.</a:t></a:r><a:endParaRPr/><a:hlinkClick r:id="rId9"/></a:p></p:txBody></p:sp>
    <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Table fact</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
    <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart 4"/></p:nvGraphicFramePr><a:graphic><a:graphicData><c:chart r:id="rId4"/></a:graphicData></a:graphic></p:graphicFrame>
    <p:pic><p:nvPicPr><p:cNvPr id="6" name="Meaningful logo"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>
  </p:spTree></p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`);
  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  zip.file("ppt/charts/chart1.xml", "<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"/>");
  zip.file("ppt/notesSlides/notesSlide1.xml", "<p:notes xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>");
  return { JSZip, bytes: await zip.generateAsync({ type: "uint8array" }) };
}
