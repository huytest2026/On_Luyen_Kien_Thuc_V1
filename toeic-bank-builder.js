/* V45.1.4 — Auto-read Answer Key from source PDF; separate answer PDF optional. */
/* V45.1.3 — Remove source PDF option echoes from Part 6 passage. */
/* V45.1.2 — Clean duplicated Part 6 option lines from passage text. */
/* V45.1.1: use the PDF.js global already loaded by index.html.
 * Do NOT use ES-module CDN import here: the host page is Apps Script HTML and
 * already loads pdf.js 3.11.174 before this file. */
const pdfjsLib = window.pdfjsLib;buildColumnRegions
if (!pdfjsLib) {
  console.error('[TOEIC Bank Builder] PDF.js is not loaded.');
}

/* V45.1.0 — Integrated TOEIC Bank Builder
 * PDF đề + PDF đáp án -> Part 5 / 6 / 7 bank.
 * Source-first, review-before-official-export.
 */
const $=id=>document.getElementById(id);
let sourcePdf=null, sourcePdfs=new Map(), sourceFiles=[], answerPdf=null, worker=null, stopped=false;
let pageInfo=[], bank=[], groups=[], answerFindings=[], passageBlobs=new Map(), editingIndex=-1;
const status=t=>{const e=$('status');if(e)e.textContent=t};
const progress=x=>{const e=$('bar');if(e)e.style.width=Math.max(0,Math.min(100,x))+'%'};
const norm=s=>String(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\s+\n/g,'\n').trim();
const clean=s=>norm(s).replace(/www[.,]?nhantriviet\.com/gi,'').replace(/Go on\s*(to|the)?\s*next page/gi,'').replace(/TOEIC BOOK STORE/gi,'').replace(/Copyright\s+www\.Hackers\.co\.kr\s+All\s+rights\s+reserved\.?(?:\s+(?:10[1-9]|1[1-9]\d|200)\.)?/gi,'').replace(/www\.Hackers\.co\.kr\s+All\s+rights\s+reserved\.?(?:\s+(?:10[1-9]|1[1-9]\d|200)\.)?/gi,'').trim();
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function actualFromText(t){
 const s=String(t||'').replace(/\bActuaI\b/gi,'Actual').replace(/\bActua1\b/gi,'Actual').replace(/\bActuai\b/gi,'Actual');
 let m=s.match(/Actual\s*Test\s*0?([0-9]{1,2})\b/i)||s.match(/Actu[a-z0-9|]{0,3}\s*Test\s*[O0]?([0-9]{1,2})\b/i);
 return m?'Actual Test '+String(Number(m[1])).padStart(2,'0'):'';
}
function qNumbers(t){
  if(isAnswerKeyPage(t)) return [];
  const src = String(t || '');
  // Kiểm tra trên toàn bộ dải câu chuẩn 101-200
  const hasStandard101 = /(?:^|[\s|])(?:10[1-9]|1[1-9]\d|200)\s*[.)\-:]?\s+[A-Za-z(“"']/.test(src);

  const re = hasStandard101
    ? /(?:^|[\s|])(10[1-9]|1[1-9]\d|200)\s*[.)\-:]?\s+(?=[A-Za-z(“"'])/g
    : /(?:^|[\s|])((?:10[1-9]|1[1-9]\d|200)|(?:[1-9]|[1-3]\d|40))\s*[.)\-:]?\s+(?=[A-Za-z(“"'])/g;

  const a = [];
  let m;
  while ((m = re.exec(src))) {
    let n = Number(m[1]);
    if (!hasStandard101 && n >= 1 && n <= 40) n += 100;
    a.push(n);
  }
  return [...new Set(a)];
}

function splitQuestionChunks(text){
  const src = String(text || '').replace(/\r/g, '');
  // Kiểm tra trên toàn bộ dải câu chuẩn 101-200
  const hasStandard101 = /(?:^|\n)\s*(?:10[1-9]|1[1-9]\d|200)\s*[.)\-:]?\s+[A-Za-z(“"']/.test(src);

  const re = hasStandard101
    ? /(?:^|\n)\s*(10[1-9]|1[1-9]\d|200)\s*[.)\-:]?\s+(?=[A-Za-z(“"'])/g
    : /(?:^|\n)\s*((?:10[1-9]|1[1-3]\d|140|14[1-9]|15\d|16\d|17\d|18\d|19\d|200)|(?:[1-9]|[1-3]\d|40))\s*[.)\-:]?\s+(?=[A-Za-z(“"'])/g;

  const hits = [];
  let m;
  while ((m = re.exec(src))) {
    let n = Number(m[1]);
    if (!hasStandard101 && n >= 1 && n <= 40) n += 100;
    hits.push({ n, start: m.index + m[0].length });
  }

  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : src.length;
    out.push({ n: hits[i].n, text: clean(src.slice(hits[i].start, end)) });
  }
  return out.filter(x => x.n >= 101 && x.n <= 200);
}

function buildColumnRegions(p){
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) return [];

  const pageText = items.map(i => i.text).join(' ');
  // Kiểm tra trên toàn bộ dải câu chuẩn 101-200
  const hasStandard101 = /(?:^|\s)(?:10[1-9]|1[1-9]\d|200)\s*[.)\-:]?/.test(pageText);

  const mid = Number(p.mid || p.width / 2 || 300);
  const cols = (p.columns === 2) ? [items.filter(i => i.x < mid), items.filter(i => i.x >= mid)] : [items];
  const regions = [];

  const makeLines = arr => {
    const ys = [];
    for (const it of arr) {
      let row = ys.find(r => Math.abs(r.y - it.y) <= 3);
      if (!row) { row = { y: it.y, items: [] }; ys.push(row); }
      row.items.push(it);
    }
    return ys.sort((a, b) => b.y - a.y).map(r => {
      r.items.sort((a, b) => a.x - b.x);
      return { y: r.y, x: Math.min(...r.items.map(i => i.x)), items: r.items, text: clean(r.items.map(i => i.text).join(' ')) };
    }).filter(r => r.text);
  };

  const qReStandard = /^(10[1-9]|1[0-9]{2}|200)\s*[.)\-:]?(?:\s|$)/;
  const qReNonStandard = /^(?:(10[1-9]|1[0-9]{2}|200)|([1-9]|[1-3]\d|40))\s*[.)\-:]?(?:\s|$)/;

  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci].slice();
    const lines = makeLines(col);
    const minX = Math.min(...col.map(x => x.x));
    const anchors = [];

    for (const line of lines) {
      if (hasStandard101) {
        const m = line.text.match(qReStandard);
        if (!m) continue;
        let n = Number(m[1]);
        if (line.x <= minX + 45) anchors.push({ n, y: line.y, x: line.x });
      } else {
        const m = line.text.match(qReNonStandard);
        if (!m) continue;
        let n = m[1] ? Number(m[1]) : (Number(m[2]) + 100);
        if (n < 101 || n > 200) continue;
        if (line.x <= minX + 45) anchors.push({ n, y: line.y, x: line.x });
      }
    }

    const uniq = [];
    const seen = new Set();
    for (const a of anchors) {
      const k = a.n + '|' + Math.round(a.y);
      if (!seen.has(k)) { seen.add(k); uniq.push(a); }
    }

    for (let i = 0; i < uniq.length; i++) {
      const a = uniq[i], next = uniq[i + 1];
      const yTop = a.y + 10, yBottom = next ? next.y + 2 : -Infinity;
      const regionItems = col.filter(it => it.y <= yTop && it.y > yBottom);
      regions.push({ n: a.n, column: ci, y: a.y, x: a.x, items: regionItems });
    }
  }
  return regions.sort((a, b) => b.y - a.y || a.column - b.column);
}
function linesFromRegionItems(items){
 const ys=[];
 for(const it of items){let row=ys.find(r=>Math.abs(r.y-it.y)<=3);if(!row){row={y:it.y,items:[]};ys.push(row)}row.items.push(it)}
 return ys.sort((a,b)=>b.y-a.y).map(r=>{r.items.sort((a,b)=>a.x-b.x);return {y:r.y,x:Math.min(...r.items.map(i=>i.x)),items:r.items,text:clean(r.items.map(i=>i.text).join(' '))}}).filter(r=>r.text);
}
function parseGeometryQuestion(region,p){
 const lines=linesFromRegionItems(region.items);
 // Remove the numeric anchor itself; it is metadata, not part of the stem.
 const body=lines.map(line=>({ ...line, text:clean(line.text.replace(new RegExp('^(?:'+region.n+')[.)\\-:]?\\s*'),'').trim()) })).filter(line=>line.text);
 const markerRe=/^\s*(?:\(([ABCD])\)|([ABCD])\s*[.)\-:])\s*/i;
 const hits=[];
 for(let i=0;i<body.length;i++){
   const text=body[i].text;
   const m=text.match(markerRe);
   if(m)hits.push({i,letter:(m[1]||m[2]).toUpperCase()});
 }
 const o={A:'',B:'',C:'',D:''};
 if(!hits.length){
   return {n:region.n,q:clean(body.map(x=>x.text).join(' ')),A:'',B:'',C:'',D:'',page:p.page,actual:p.actual,sourceFile:p.sourceFile,doc:p.doc,parseMode:'geometry-no-options'};
 }
 const q=clean(body.slice(0,hits[0].i).map(x=>x.text).join(' '));
 for(let i=0;i<hits.length;i++){
   const h=hits[i],end=i+1<hits.length?hits[i+1].i:body.length;
   const first=body[h.i].text.replace(markerRe,'');
   o[h.letter]=clean([first,...body.slice(h.i+1,end).map(x=>x.text)].join(' '));
 }
 return {n:region.n,q,A:o.A,B:o.B,C:o.C,D:o.D,page:p.page,actual:p.actual,sourceFile:p.sourceFile,doc:p.doc,parseMode:'geometry'};
}

function parsePart6GeometryQuestionsFromPage(p){
 const items=Array.isArray(p.items)?p.items:[];
 if(!items.length)return [];
 // PART 6 IS A PASSAGE, NOT 12 INDEPENDENT QUESTIONS.
 // Keep the passage as one logical object.  The question number marks a blank
 // inside that passage; A/B/C/D belong to that blank only.
 const QMIN=141,QMAX=152;
 const qRe=/^(141|142|143|144|145|146|147|148|149|150|151|152)\s*[.)\-:]?/i;
 const optRe=/^(?:\(?([ABCD])\)?)[.)\-:\s]+(.*)$/i;
 const makeLines=arr=>{
   const rows=[];
   for(const it of arr){
     let r=rows.find(x=>Math.abs(x.y-it.y)<=3);
     if(!r){r={y:it.y,items:[]};rows.push(r)}
     r.items.push(it);
   }
   // Part 6 follows the physical reading order from top to bottom.
   // Do NOT reverse Y here: options for 141/142/... are located BELOW the
   // numbered anchor, and reversing the order makes a question absorb the
   // options/text of a later question.
   return rows.sort((a,b)=>b.y-a.y).map(r=>{
     r.items.sort((a,b)=>a.x-b.x);
     return {y:r.y,x:Math.min(...r.items.map(i=>i.x)),items:r.items,text:clean(r.items.map(i=>i.text).join(' '))};
   }).filter(r=>r.text);
 };
 // Never split Part 6 into left/right columns.  Some PDFs indent the choices,
 // but the reading passage itself is one continuous stream.
 const lines=makeLines(items);
 const anchors=[];
 for(let i=0;i<lines.length;i++){
   const m=lines[i].text.match(qRe);
   if(m)anchors.push({n:Number(m[1]),i,y:lines[i].y});
 }
 if(!anchors.length)return [];
 const uniq=[];const seen=new Set();
 for(const a of anchors){if(a.n<QMIN||a.n>QMAX)continue;const k=a.n+'|'+Math.round(a.y);if(!seen.has(k)){seen.add(k);uniq.push(a)}}
 if(!uniq.length)return [];

 // Extract four choices from the four lines belonging to each numbered blank.
 const byQ=new Map();
 for(let k=0;k<uniq.length;k++){
   const a=uniq[k],o={A:'',B:'',C:'',D:''};
   let got=0;
   // The A line is the numbered anchor itself (e.g. 141. (A) record).
   // Then B/C/D must be the next option lines in vertical reading order.
   for(let j=a.i;j<Math.min(lines.length,a.i+5);j++){
     const raw=lines[j].text;
     const t=raw.replace(/^\s*(?:\d{3})[.)\-:]?\s*/,'').trim();
     const m=t.match(optRe);
     if(!m){
       if(j>a.i && got>0) break;
       continue;
     }
     const letter=m[1].toUpperCase();
     // Never cross into the next numbered question.
     if(j>a.i && /^\s*(?:141|142|143|144|145|146|147|148|149|150|151|152)\s*[.)\-:]/.test(raw)) break;
     if(!o[letter]){o[letter]=clean(m[2]);got++;}
     if(got===4)break;
   }
   byQ.set(a.n,o);
 }

 // Remove answer-choice lines from the passage, but keep EVERYTHING else in
 // its original reading order: heading, From/To/Subject, paragraphs, blanks,
 // and the surrounding sentences.  This is what the learner should see.
 const optionYs=new Set();
 for(const a of uniq){
   for(let j=a.i;j<Math.min(lines.length,a.i+6);j++){
     if(/^\s*(?:\d{3}\s*)?\(?[ABCD]\)?[.)\-:\s]+/i.test(lines[j].text)) optionYs.add(Math.round(lines[j].y));
   }
 }
 const passageLines=lines.filter(l=>!optionYs.has(Math.round(l.y)));
 let passageText=passageLines.map(l=>l.text).join('\n');

 // V45.1.2: remove duplicated answer-choice lines that PDF.js may leave
 // inside the passage. Only remove a line when its text exactly matches
 // an A/B/C/D option already extracted for this Part 6 group.
 const extractedOptionTexts=new Set();
 for(const o of byQ.values()){
   for(const letter of ['A','B','C','D']){
     const v=clean(o[letter]||'');
     if(v) extractedOptionTexts.add(v.toLowerCase());
   }
 }
 passageText=passageText.split('\n').filter(line=>{
   const s=String(line||'').trim();

   // PDF.js may leave the original answer-choice line inside the passage in
   // several forms:
   //   (A) record
   //   A. record
   //   141. (A) record
   //   141 (A) record
   // Remove it only when the option text is one of the options extracted for
   // this Part 6 group.
   const m=s.match(/^(?:\d{3}\s*[.)\-:]?\s*)?\(?([ABCD])\)?[.)\-:\s]+(.+)$/i);
   if(m){
     const optionText=clean(m[2]||'').toLowerCase();
     if(extractedOptionTexts.has(optionText)) return false;
   }

   // Some PDF layouts put the question number in front of the source option
   // without a clean A/B/C/D match. Remove only the exact "number + option"
   // pattern when the trailing text matches a known option.
   const qm=s.match(/^(141|142|143|144|145|146|147|148|149|150|151|152)\s*[.)\-:]?\s*(?:\(?[ABCD]\)?[.)\-:\s]+)(.+)$/i);
   if(qm){
     const optionText=clean(qm[2]||'').toLowerCase();
     if(extractedOptionTexts.has(optionText)) return false;
   }

   return true;
 }).join('\n');

 // Remove isolated Part 6 question numbers left by PDF extraction.
 // Keep numbered sentences such as "141. ____ ..." intact; only a number
 // standing alone is discarded.
 passageText=passageText.replace(
   /(^|\n)\s*(141|142|143|144|145|146|147|148|149|150|151|152)\s*[.)\-:]?\s*(?=\n|$)/gi,
   '$1'
 ).trim();
 // If the PDF puts the number immediately after the blank line, preserve a
 // visible marker in the passage for that question.
 for(const a of uniq){
   const marker=new RegExp('(^|\\n)([^\\n]*?)\\b'+a.n+'\\s*[.)\\-:]?\\s*(?=\\n|$)','i');
   if(marker.test(passageText)) passageText=passageText.replace(marker,'$1$2['+a.n+']');
 }
 passageText=clean(passageText);

 // A question record keeps the WHOLE passage.  The four choices are the only
 // interactive alternatives.  PassageText is explicit for future UI/grouping;
 // CauHoi remains the same full passage so this builder never turns 141-152
 // into independent Part-5-style sentences.
 return uniq.map(a=>{
   const o=byQ.get(a.n)||{A:'',B:'',C:'',D:''};
   const blankPassage=passageText.replace(/[-_]{3,}/g,'____');
   return {
     n:a.n,
     q:blankPassage,
     PassageText:blankPassage,
     BlankNumber:a.n,
     A:o.A,B:o.B,C:o.C,D:o.D,
     page:p.page,actual:p.actual,sourceFile:p.sourceFile,doc:p.doc,
     parseMode:'geometry-p6-passage'
   };
 });
}

function parseGeometryQuestionsFromPage(p){
 if(!Array.isArray(p.items)||!p.items.length)return [];
 if(p.isAnswerPage||isAnswerKeyPage(p.text||''))return [];
 const p6=parsePart6GeometryQuestionsFromPage(p);
 if(p6.length)return p6;
 return buildColumnRegions(p).map(r=>parseGeometryQuestion(r,p)).filter(r=>r.n>=101&&r.n<=200);
}
function parseQuestionsFromPages(pages){
 const rows=[];
 for(const p of pages){
  if(!p.actual)continue;
  const geo=parseGeometryQuestionsFromPage(p);
  if(geo.length){
   for(const r of geo){if(!rows.some(x=>x.n===r.n&&x.page===r.page&&x.sourceFile===r.sourceFile))rows.push(r)}
   continue;
  }
  // Legacy fallback is retained for unusual single-column/scanned PDFs.
  const ptext=String(p.text||'');
  if(p.isAnswerPage||/Answers[._\s-]*Actual\s*Test/i.test(ptext)||isAnswerKeyPage(ptext))continue;
  const hasP6=/\b(?:141|142|143|144|145|146|147|148|149|150|151|152)\s*[.)\-:]?\s*\(A\)/i.test(ptext);
  const parsed=hasP6?parsePart6QuestionsFromPage(p):[];
  if(parsed.length){for(const r of parsed){if(!rows.some(x=>x.n===r.n&&x.page===r.page&&x.sourceFile===r.sourceFile))rows.push({...r,parseMode:'legacy-p6'})};continue;}
  for(const ch of splitQuestionChunks(ptext)){
   if(isAnswerKeyPage(ch.text))continue;
   const po=parseOptions(ch.text);
   if(!po.q&&!po.A&&!po.B&&!po.C&&!po.D)continue;
   if(!rows.some(r=>r.n===ch.n&&r.page===p.page&&r.sourceFile===p.sourceFile))rows.push({n:ch.n,q:po.q,A:po.A,B:po.B,C:po.C,D:po.D,page:p.page,actual:p.actual,sourceFile:p.sourceFile,doc:p.doc,parseMode:'legacy'});
  }
 }
 return rows;
}

function buildGroupsFromBankRows(rows){
 const gs=[];
 for(const test of [...new Set(rows.map(r=>r.actual).filter(Boolean))]){
  const rr=rows.filter(r=>r.actual===test).sort((a,b)=>a.n-b.n);
  const p6=rr.filter(r=>r.n>=141&&r.n<=152);
  const p6Headers=[];
  for(const p of pageInfo.filter(p=>p.actual===test)){
   const t=String(p.text||'').replace(/[–—]/g,'-').replace(/\s+/g,' ');
   const re=/Questions?\s*(141|142|143|144|145|146|147|148|149|150|151|152)\s*(?:-|to)\s*(141|142|143|144|145|146|147|148|149|150|151|152)\s*(?:refer|refe?r|r[e3]fer)\s*(?:to)?/gi;
   let m; while((m=re.exec(t))){const a=Number(m[1]),b=Number(m[2]);if(b>=a)p6Headers.push({start:a,end:b,page:p.page});}
  }
  const p6u=[],p6seen=new Set(); for(const h of p6Headers){const k=h.start+'-'+h.end;if(!p6seen.has(k)){p6seen.add(k);p6u.push(h)}}
  if(p6u.length){for(let i=0;i<p6u.length;i++){const h=p6u[i],q0=p6.find(q=>q.n>=h.start&&q.n<=h.end),q1=[...p6].reverse().find(q=>q.n>=h.start&&q.n<=h.end);if(q0)gs.push({id:`P6-T${test.slice(-2)}-G${String(i+1).padStart(2,'0')}`,test,start:h.start,end:h.end,startPage:q0.page||h.page,endPage:q1?.page||h.page,part:'Part 6'});}}
  else { for(let i=0;i<p6.length;){const start=p6[i].n;let end=start,j=i+1;while(j<p6.length&&p6[j].n===end+1){end=p6[j].n;j++}if(j-i>=2)gs.push({id:`P6-T${test.slice(-2)}-G${String(gs.length+1).padStart(2,'0')}`,test,start,end,startPage:p6[i].page,endPage:p6[j-1]?.page||p6[i].page,part:'Part 6'});i=j;}}
  const p7=rr.filter(r=>r.n>=153&&r.n<=200);let idx=1;
  // Prefer explicit "Questions xxx–yyy refer to..." headers from the source pages.
  const headers=[];
  for(const p of pageInfo.filter(p=>p.actual===test)){
   const t=String(p.text||'').replace(/[–—]/g,'-').replace(/\s+/g,' ');
   const re=/Questions?\s*(153|1[5-9]\d|200)\s*(?:-|to)\s*(153|1[5-9]\d|200)\s*(?:refer|refe?r|r[e3]fer)\s*(?:to)?/gi;let m;
   while((m=re.exec(t))){const a=Number(m[1]),b=Number(m[2]);if(a>=153&&b<=200&&b>=a)headers.push({start:a,end:b,page:p.page});}
  }
  const uniq=[];const seen=new Set();for(const h of headers){const k=h.start+'-'+h.end;if(!seen.has(k)){seen.add(k);uniq.push(h)}}
  if(uniq.length){
   for(const h of uniq){const q0=p7.find(q=>q.n>=h.start&&q.n<=h.end),q1=[...p7].reverse().find(q=>q.n>=h.start&&q.n<=h.end);gs.push({id:`P7-T${test.slice(-2)}-G${String(idx++).padStart(2,'0')}`,test,start:h.start,end:h.end,startPage:q0?.page||h.page,endPage:q1?.page||h.page,part:'Part 7'});}
  }else{
   // Fallback when headers are lost: split at non-contiguous runs, but never fabricate a group boundary.
   for(let i=0;i<p7.length;){const start=p7[i].n;let end=start,j=i+1;while(j<p7.length&&p7[j].n===end+1){end=p7[j].n;j++}if(end-start+1>=2)gs.push({id:`P7-T${test.slice(-2)}-G${String(idx++).padStart(2,'0')}`,test,start,end,startPage:p7[i].page,endPage:p7[j-1]?.page||p7[i].page,part:'Part 7'});i=j;}
  }
 }
 return gs;
}
function makeRecord(r,part,group){
 const t=r.actual||'Actual Test 01',num=r.n,tid=t.slice(-2),gid=group?.id||'';
 const src=r.sourceFile||'PDF người dùng chọn';
 return {MaCau:`${part.replace(' ','')}-T${tid}-${num}`,Part:part,CauSo:num,ActualTest:t,GroupID:gid,ChuDe:'PDF người dùng chọn',DangBai:part==='Part 5'?'Hoàn thành câu':part==='Part 6'?'Đọc đoạn văn và chọn đáp án':'Đọc hiểu theo bài',CauHoi:r.q||'',PassageText:r.PassageText||'',BlankNumber:r.BlankNumber||num,DapAnA:r.A||'',DapAnB:r.B||'',DapAnC:r.C||'',DapAnD:r.D||'',DapAnDung:'',GiaiThich:'',PassageImageURL:'',HinhBaiDoc:'',SourcePageStart:r.page||'',SourcePageEnd:r.page||'',Source:src,DataStatus:'SOURCE_PDF_PARSED_PENDING_REVIEW',GroupIndex:group?Number(group.id.match(/G(\d+)$/)?.[1]||0):0,GroupStart:group?.start||'',GroupEnd:group?.end||'',ReviewStatus:'PENDING',QualityStatus:(r.parseMode||'').startsWith('geometry')?'PASS':'LEGACY_PARSE'};
}
function renderSummary(){
 const tests=[...new Set(bank.map(x=>x.ActualTest))];const counts={};for(const q of bank)counts[q.Part]=(counts[q.Part]||0)+1;
 $('summary').innerHTML=`<b>${bank.length}</b> câu · <b>${tests.length}</b> Actual Test · Part 5: <b>${counts['Part 5']||0}</b> · Part 6: <b>${counts['Part 6']||0}</b> · Part 7: <b>${counts['Part 7']||0}</b>`;
 $('tests').innerHTML=tests.map(t=>{const qs=bank.filter(q=>q.ActualTest===t);return `<div class="test-card"><h3>${esc(t)}</h3><span class="badge">${qs.length} câu</span><div class="small">${['Part 5','Part 6','Part 7'].filter(p=>qs.some(q=>q.Part===p)).map(p=>p+': '+qs.filter(q=>q.Part===p).length).join(' · ')}</div></div>`}).join('');
}
async function scan(){
 const files=[...($('pdfFile').files||[])];
 if(!files.length){status('⚠️ Hãy chọn ít nhất một PDF đề.');return}
 reset();stopped=false;$('btnScan').disabled=true;$('btnStop').disabled=false;progress(0);
 try{
  const startInput=Math.max(1,Number($('startPage').value)||1);
  const endInput=Number($('endPage').value)||0;
  const allPages=[]; sourceFiles=files.slice();
  let processed=0,total=0;
  for(const f of files){const d=await openPdf(f);total+=Math.max(0,Math.min(d.numPages,endInput||d.numPages)-startInput+1);sourcePdfs.set(f.name,d)}
  for(let fi=0;fi<files.length&&!stopped;fi++){
   const f=files[fi],doc=sourcePdfs.get(f.name);sourcePdf=doc;
   const s=Math.min(doc.numPages,startInput),e=Math.min(doc.numPages,endInput||doc.numPages);
   for(let n=s;n<=e&&!stopped;n++){
    let pg=await pageLayout(doc,n);
    if(!pg.text){const r=await renderPage(doc,n,.9),o=await ocrCanvas(r.canvas);pg={page:n,text:o.text,lines:o.text.split(/\n/).map(x=>({x:0,y:0,text:x})),source:'ocr'}}else pg.source='text';
    pg.doc=doc;pg.sourceFile=f.name;allPages.push(pg);processed++;progress(Math.min(55,processed/Math.max(1,total)*55));
   }
   status(`📖 Đã phân tích đề ${fi+1}/${files.length}: ${f.name}`);
  }
  const byFile=new Map();for(const p of allPages){if(!byFile.has(p.sourceFile))byFile.set(p.sourceFile,[]);byFile.get(p.sourceFile).push(p)}
  let fi=0;for(const [fname,pages] of byFile){detectTestsFromPages(pages);inferTestsFromQuestionPages(pages,fname,fi+1);fi++}
  pageInfo=allPages;
  let rows=[];for(const p of pageInfo)for(const r of parseQuestionsFromPages([p]))rows.push({...r,sourceFile:p.sourceFile,doc:p.doc});
  // If a PDF has a text layer but its line structure prevents question detection,
  // OCR only that source as a fallback instead of silently producing 0 câu.
  const filesWithRows=new Set(rows.map(r=>r.sourceFile));
  for(const f of files){
   if(stopped||filesWithRows.has(f.name))continue;
   const doc=sourcePdfs.get(f.name);if(!doc)continue;
   status(`🧠 OCR dự phòng cho ${f.name} vì chưa nhận được câu 101–200…`);
   const extra=[];
   for(let n=1;n<=doc.numPages&&!stopped;n++){
    const pg=pageInfo.find(x=>x.sourceFile===f.name&&x.page===n);if(!pg)continue;
    const r=await renderPage(doc,n,.9),o=await ocrCanvas(r.canvas);
    const op={...pg,text:o.text,source:'ocr'};extra.push(op);pageInfo[pageInfo.indexOf(pg)]=op;
   }
   const ep=extra.filter(x=>x.actual);for(const p of ep)for(const r of parseQuestionsFromPages([p]))rows.push({...r,sourceFile:f.name,doc});
  }
  const partRows=rows.filter(r=>r.n>=101&&r.n<=200);groups=buildGroupsFromBankRows(partRows);bank=[];
  for(const r of partRows){const part=inferPart(r.n),g=groups.find(x=>x.test===r.actual&&r.n>=x.start&&r.n<=x.end&&x.part===part);bank.push(makeRecord(r,part,g))}
  const seen=new Set();bank=bank.filter(q=>{const k=q.ActualTest+'|'+q.CauSo;if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.ActualTest.localeCompare(b.ActualTest)||a.CauSo-b.CauSo);
  renderSummary();renderBank();$('btnAnswers').disabled=!bank.length;$('btnExport').disabled=!bank.length;$('btnOCR').disabled=!bank.length;
  const badCount=bank.filter(q=>q.ReviewStatus!=='VERIFIED'&&suspiciousQuestion(q)).length;
  status(`✅ Đã phân tích ${bank.length} câu từ ${files.length} PDF đề.${badCount?` ⚠️ ${badCount} câu cần REPAIR/AI.`:''}`);
  if(bank.length){
   status(`🔑 Đã phân tích ${bank.length} câu từ ${files.length} PDF. Đang tự động tìm Answer Key…`);
   await recognizeAnswers();
  }else status(`✅ Đã phân tích ${bank.length} câu từ ${files.length} PDF đề.${bank.length?'':' ⚠️ Không nhận được câu 101–200 trong phạm vi trang đã chọn.'}`);
 }catch(e){console.error(e);status('❌ '+(e.message||e))}finally{$('btnScan').disabled=false;$('btnStop').disabled=true}
}
async function ocrAllMissing(){
 if(!sourcePdf||!bank.length)return;const missing=bank.filter(q=>!q.CauHoi||!q.DapAnA||!q.DapAnB||!q.DapAnC||!q.DapAnD);if(!missing.length){status('✅ Không có câu thiếu dữ liệu.');return}stopped=false;for(let i=0;i<missing.length&&!stopped;i++){const q=missing[i];const meta=pageInfo.find(p=>p.sourceFile===q.Source&&p.page===Number(q.SourcePageStart));const doc=meta?.doc||sourcePdf;if(!doc)continue;const r=await renderPage(doc,q.SourcePageStart,1.25),o=await ocrCanvas(r.canvas);const ch=splitQuestionChunks(o.text).find(x=>x.n===q.CauSo);if(ch){const po=parseOptions(ch);Object.assign(q,{CauHoi:po.q,DapAnA:po.A,DapAnB:po.B,DapAnC:po.C,DapAnD:po.D,DataStatus:'SOURCE_OCR_PENDING_REVIEW'})}progress((i+1)/missing.length*100);status(`🧠 OCR bổ sung ${q.ActualTest} câu ${q.CauSo}…`)}renderBank();status('✅ Đã hoàn tất OCR bổ sung.');}
function parseAnswerText(text){
 const out={};let s=String(text||'').replace(/\b(Actual\s*Test)\b/gi,'Actual Test');
 // Accept 101 (B), 101 B, 101. B and OCR-style 0/8/C/D after a number.
 const re=/(?:^|[\s|])(10[1-9]|1[1-9]\d|19\d|200)\s*[.)\-:]?\s*\(?([ABCD])\)?\b/gi;let m;while((m=re.exec(s)))out[Number(m[1])]=m[2].toUpperCase();
 // OCR sometimes turns B into 8 or D into 0. Only use when immediately following the question number.
 const re2=/(?:^|[\s|])(10[1-9]|1[1-9]\d|19\d|200)\s*[.)\-:]?\s*\(?([08])\)?\b/gi;while((m=re2.exec(s))){const a=m[2]==='8'?'B':'D';if(!out[Number(m[1])])out[Number(m[1])]=a}
 return out;
}
async function recognizeAnswers(){
 const selectedAnswerFile=$('answerFile')?.files?.[0]||null;
 if(!bank.length){status('⚠️ Hãy phân tích PDF đề trước.');return}
 // V45.1.4: Answer Key may be printed at the end of the SAME source PDF.
 // Use an explicitly selected answer PDF when supplied; otherwise scan the
 // full source PDFs already loaded by the Builder for their answer-key pages.
 const answerSources=[];
 if(selectedAnswerFile) answerSources.push({file:selectedAnswerFile,doc:await openPdf(selectedAnswerFile)});
 else for(const [name,doc] of sourcePdfs) answerSources.push({file:null,name,doc});
 if(!answerSources.length){status('⚠️ Không có PDF nguồn để tìm Answer Key.');return}
 $('btnAnswers').disabled=true;answerFindings=[];
 try{
  // Build answer sections by explicit "Test N" headings. This prevents answers from
  // Test 2..10 overwriting Test 1 when one answer PDF contains many tests.
  const sections={},allAnswerPages=[];
  for(const src of answerSources){
   let currentTest=0;
   for(let p=1;p<=src.doc.numPages;p++){
    // Use full-width extraction for Answer Key pages; pageText() uses a
    // two-column split that is correct for question pages but breaks the
    // middle (3rd) answer pair in 5-column keys.
    const text=await answerKeyPageText(src.doc,p);
    const compact=String(text||'').replace(/\s+/g,' ');
    const hits=[...String(text||'').matchAll(/(?:^|\n)\s*Test\s*0?(\d{1,2})\s*$/gim)];
    if(hits.length)currentTest=Number(hits[hits.length-1][1]);
    // Also catch headings embedded in OCR/text flow, but avoid TOC lines with dots/page numbers.
    if(!currentTest){const m=compact.match(/\bTest\s*0?(\d{1,2})\s*$/i);if(m)currentTest=Number(m[1]);}
    const item={page:p,text,sourceName:src.file?.name||src.name||'',testNo:currentTest};
    allAnswerPages.push(item);
    if(currentTest)(sections[currentTest]??=[]).push(item);
   }
  }

  const byTest={};for(const q of bank)(byTest[q.ActualTest]??=[]).push(q);
  for(const [test,qs] of Object.entries(byTest)){
   const m=test.match(/(\d+)$/);const testNo=m?Number(m[1]):1;
   const candidatePages=sections[testNo]||[];
   // If no explicit Test heading exists (common when the answer key is printed
   // as a compact row at the end of each source PDF), first prefer the source
   // file whose name identifies the same test, then fall back to all answer pages.
   let pagesToUse=candidatePages;
   if(!pagesToUse.length){
    const nameMatches=allAnswerPages.filter(x=>new RegExp('(?:De|Test|TEST)\\s*[-_ ]*0?'+testNo+'(?:\\D|$)','i').test(x.sourceName));
    pagesToUse=nameMatches.length?nameMatches:allAnswerPages;
   }
   let answers={};let pagesUsed=[];
   for(const item of pagesToUse){
    const text=item.text||'';
    const a=parseAnswerText(text);
    const useful=Object.keys(a).some(n=>qs.some(q=>q.CauSo===Number(n)));
    if(useful){Object.assign(answers,a);pagesUsed.push(item.page)}
   }
   let assigned=0;
   for(const q of qs){if(answers[q.CauSo]){q.DapAnDung=answers[q.CauSo];q.AnswerSource=`PDF đáp án · Test ${testNo} · trang ${pagesUsed.join(',')}`;q.AnswerStatus='AUTO_DETECTED_PENDING_VERIFY';assigned++}}
   answerFindings.push({test,pages:pagesUsed.join(','),detected:Object.keys(answers).length,assigned,confidence:assigned===qs.length?'HIGH':assigned?'MEDIUM':'NONE'});
  }
  renderAnswers();renderBank();status('✅ Đã phân tích đề và ghép đáp án từ Answer Key (trong PDF đề hoặc PDF đáp án). Tất cả đáp án vẫn ở trạng thái chờ xác nhận.');
 }catch(e){status('❌ Không đọc được PDF đáp án: '+e.message)}finally{$('btnAnswers').disabled=false}
}

function renderAnswers(){const total=answerFindings.reduce((n,x)=>n+x.assigned,0);$('answerStatus').innerHTML=`<b>${answerFindings.length}</b> Actual Test · <b>${total}</b> đáp án gán được. ⚠️ Cần kiểm tra trước khi xuất chính thức.`;$('answerRows').innerHTML=answerFindings.map(x=>`<tr><td>${esc(x.test)}</td><td>${esc(x.pages||'—')}</td><td>${x.detected}</td><td>${x.assigned}</td><td class="${x.confidence==='HIGH'?'ok':'bad'}">${x.confidence}</td></tr>`).join('')}

function isReviewComplete(q){
 const has=v=>String(v??'').trim().length>0;
 const ans=String(q?.DapAnDung||'').trim().toUpperCase();
 return !!(q&&has(q.CauHoi)&&has(q.DapAnA)&&has(q.DapAnB)&&has(q.DapAnC)&&has(q.DapAnD)&&/^[ABCD]$/.test(ans));
}
function suspiciousQuestion(q){
 const vals=[q.CauHoi,q.DapAnA,q.DapAnB,q.DapAnC,q.DapAnD].map(v=>String(v||'').trim());
 if(!vals[0]||vals.slice(1).some(v=>!v))return true;
 if(vals.slice(1).some(v=>/^(?:10[1-9]|1[0-9]{2}|200)[.)-]?$/.test(v)))return true;
 // A question/option marker from another question embedded in the field is
 // a hard corruption signal, e.g. "... 149. (A) also" inside Q146.
 if(vals.some(v=>/\b(?:10[1-9]|1[0-9]{2}|200)\s*[.)-:]?\s*\([ABCD]\)/i.test(v)))return true;
 if(vals.some(v=>/\b(?:10[1-9]|1[0-9]{2}|200)\s*[.)-:]?\s*$/.test(v)))return true;
 return false;
}
function syncIncompleteStatuses(){
 for(const q of bank){
   if(suspiciousQuestion(q)||!isReviewComplete(q)){
     if(q.ReviewStatus!=='VERIFIED')q.ReviewStatus='INCOMPLETE';
     q.QualityStatus=suspiciousQuestion(q)?'REPAIR':'INCOMPLETE';
   }else if(q.ReviewStatus==='INCOMPLETE'){
     q.ReviewStatus='PENDING';q.QualityStatus='PASS';
   }else if(!q.QualityStatus){q.QualityStatus='PASS'}
 }
}


function getGeminiKey(){return sessionStorage.getItem('toeic_builder_gemini_key')||''}
function setGeminiKey(k){if(k)sessionStorage.setItem('toeic_builder_gemini_key',k.trim())}
function cropQuestionCanvas(canvas,region,p){
 const scale=canvas.width/(p.width||canvas.width);
 const xs=region.items.map(i=>i.x),ys=region.items.map(i=>i.y);
 const x0=Math.max(0,(Math.min(...xs)-12)*scale),x1=Math.min(canvas.width,(Math.max(...region.items.map(i=>i.x+i.w))+20)*scale);
 // pdf coordinates have their origin at the bottom; convert to canvas top coordinates.
 const yHigh=Math.max(...ys.map((y,i)=>y+(region.items[i]?.h||10)))+8;
 const yLow=Math.min(...ys)-10;
 const top=Math.max(0,canvas.height-(yHigh*scale));
 const bottom=Math.min(canvas.height,canvas.height-(yLow*scale));
 const c=document.createElement('canvas');c.width=Math.max(80,Math.ceil(x1-x0));c.height=Math.max(80,Math.ceil(bottom-top));
 c.getContext('2d').drawImage(canvas,x0,top,c.width,c.height,0,0,c.width,c.height);return c;
}
async function geminiRepairOne(q,apiKey){
 const p=pageInfo.find(x=>x.sourceFile===q.Source&&x.page===Number(q.SourcePageStart));
 if(!p||!p.doc)return {ok:false,reason:'Không tìm thấy trang nguồn'};
 const region=buildColumnRegions(p).find(r=>r.n===q.CauSo);if(!region)return {ok:false,reason:'Không xác định được vùng câu'};
 const rendered=await renderPage(p.doc,p.page,1.7),crop=cropQuestionCanvas(rendered.canvas,region,p);
 const dataUrl=crop.toDataURL('image/jpeg',.88).split(',')[1];
 const prompt=`You are repairing a TOEIC question extracted from a PDF. Read ONLY the visible content in the supplied image. Do not infer, invent, or use outside knowledge. Return JSON only with keys question,A,B,C,D,confidence. Preserve the original wording. If any field is not clearly visible, use an empty string. The answer choice labels are A B C D. Question number is ${q.CauSo}.`;
 const url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(apiKey);
 const body={contents:[{parts:[{text:prompt},{inline_data:{mime_type:'image/jpeg',data:dataUrl}}]}],generationConfig:{responseMimeType:'application/json',temperature:0}};
 const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(!res.ok)throw new Error('Gemini HTTP '+res.status);
 const j=await res.json();const txt=j?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';let parsed;try{parsed=JSON.parse(txt)}catch{parsed=JSON.parse(txt.replace(/^```json\s*|\s*```$/g,''))}
 const cleanField=v=>String(v??'').trim();
 const fixed={CauHoi:cleanField(parsed.question),DapAnA:cleanField(parsed.A),DapAnB:cleanField(parsed.B),DapAnC:cleanField(parsed.C),DapAnD:cleanField(parsed.D)};
 if(!fixed.CauHoi||![fixed.DapAnA,fixed.DapAnB,fixed.DapAnC,fixed.DapAnD].every(Boolean))return {ok:false,reason:'AI không đọc đủ A/B/C/D'};
 Object.assign(q,fixed,{DataStatus:'AI_REPAIRED_PENDING_REVIEW',QualityStatus:'AI_REPAIRED',ReviewStatus:'PENDING'});
 return {ok:true,confidence:Number(parsed.confidence||0)};
}
async function aiRepairMissing(){
 const targets=bank.filter(q=>q.ReviewStatus!=='VERIFIED'&&suspiciousQuestion(q));
 if(!targets.length){alert('Không có câu lỗi cần AI sửa.');return}
 let key=getGeminiKey();
 if(!key){key=prompt('Nhập Gemini API key để AI sửa các câu lỗi. Key chỉ lưu trong phiên làm việc này:');if(!key)return;setGeminiKey(key)}
 const btn=$('btnAIRepair');if(btn)btn.disabled=true;stopped=false;let ok=0,fail=0;
 try{
  for(let i=0;i<targets.length&&!stopped;i++){
   const q=targets[i];status(`🧠 AI sửa ${q.ActualTest} câu ${q.CauSo} (${i+1}/${targets.length})…`);
   try{const r=await geminiRepairOne(q,key);if(r.ok)ok++;else{fail++;q.QualityStatus='AI_FAILED';}}catch(e){fail++;q.QualityStatus='AI_FAILED';console.warn(e)}
   progress((i+1)/targets.length*100);renderBank();
  }
  status(`🧠 AI Repair hoàn tất: ${ok} sửa được · ${fail} chưa sửa. Chỉ câu đủ dữ liệu mới PENDING.`);
 }finally{if(btn)btn.disabled=false}
}
function ensureP6Styles(){
 if(document.getElementById('p6-v4510-style'))return;
 const st=document.createElement('style');st.id='p6-v4510-style';st.textContent=`
 .p6-group{border:1px solid #cfd8e3;border-radius:10px;padding:12px;background:#fafcff}
 .p6-group-head{display:flex;justify-content:space-between;gap:12px;padding:7px 9px;margin-bottom:10px;background:#eef4f9;border-radius:7px}
 .p6-passage{white-space:pre-wrap;line-height:1.48;padding:12px;background:#fff;border:1px solid #e1e6eb;border-radius:8px}
 .p6-meta{font-size:12px;color:#65727d;margin-bottom:7px}
 .p6-segment{white-space:pre-wrap}
 .p6-inline-q{display:block;margin:7px 0 12px;padding:0 0 4px 0;cursor:pointer}
 .p6-inline-options{margin:4px 0 0 28px;line-height:1.48}
 .p6-inline-option{display:block}
 .p6-inline-option b{display:inline-block;min-width:22px}
 .p6-inline-q:hover{background:#f8fbfd}
 .p6-q-number{font-weight:700;margin-right:4px}
 `;document.head.appendChild(st);
}
function p6OptionsBlock(q,i){
 const opts=[['A',q.DapAnA],['B',q.DapAnB],['C',q.DapAnC],['D',q.DapAnD]];
 return `<div class="p6-inline-options">${opts.map(([l,v])=>`<span class="p6-inline-option" data-i="${i}"><b>${l}.</b> ${esc(v||'')}</span>`).join('')}</div>`;
}
function renderP6InlinePassage(g){
 const first=g.qs[0]?.q;
 if(!first)return '';
 let text=String(first.PassageText||first.CauHoi||'').replace(/\r/g,'').trim();
 text=text.replace(/[-_]{3,}/g,'____');
 const qs=g.qs.slice().sort((a,b)=>Number(a.q.CauSo)-Number(b.q.CauSo));
 // Each Part 6 record contains the same passage. Insert the options at the
 // corresponding blank position, while keeping the passage text continuous.
 const blankRe=/_{4,}/g; let cursor=0,html='',blankIndex=0,m;
 while((m=blankRe.exec(text))){
   const qx=qs[blankIndex]; if(!qx)break;
   const afterBlank=m.index+m[0].length;
   const rest=text.slice(afterBlank);
   const sentenceEnd=rest.search(/[.!?](?=\s|$)/);
   const end=sentenceEnd>=0?afterBlank+sentenceEnd+1:text.length;
   html+=`<span class="p6-segment">${esc(text.slice(cursor,m.index))}</span>`;
   html+=`<span class="p6-inline-q" data-i="${qx.i}" title="Nhấp để chỉnh sửa câu ${qx.q.CauSo}"><span class="p6-q-number">${qx.q.CauSo}.</span>${esc(text.slice(m.index,Math.min(end,text.length)))}${p6OptionsBlock(qx.q,qx.i)}</span>`;
   cursor=Math.min(end,text.length); blankIndex++;
   if(cursor>=text.length)break;
   blankRe.lastIndex=cursor;
 }
 if(cursor<text.length)html+=`<span class="p6-segment">${esc(text.slice(cursor))}</span>`;
 // If the source did not preserve enough blank markers, do not discard the
 // passage. Show the source once and keep question data available in the editor.
 if(blankIndex!==qs.length)return `<span class="p6-segment">${esc(text)}</span>`;
 return html;
}
function renderBank(){
 ensureP6Styles();
 syncIncompleteStatuses();
 const missing=bank.filter(q=>!isReviewComplete(q)).length,verified=bank.filter(q=>q.ReviewStatus==='VERIFIED').length;
 const issues=$('issues');
 if(issues){
   issues.className=missing?'dangerbox':'warnbox';
   issues.innerHTML=`<span><b>${bank.length}</b> câu · <b>${verified}</b> đã xác nhận · <b>${bank.filter(q=>q.ReviewStatus==='PENDING').length}</b> PENDING · <b>${missing}</b> INCOMPLETE</span>
    <button id="btnPendingAll" class="btn secondary" style="margin-left:12px;padding:6px 10px" ${bank.length?'':'disabled'}>↩ Đưa tất cả về PENDING</button>
    <button id="btnVerifyAll" class="btn primary" style="margin-left:8px;padding:6px 10px;background:#0b6ea8;color:#fff" ${bank.length?'':'disabled'}>✅ Xác nhận tất cả PENDING</button>
    <button id="btnAIRepair" class="btn secondary" style="margin-left:8px;padding:6px 10px;background:#7b3fb6;color:#fff" ${bank.some(q=>q.ReviewStatus!=='VERIFIED'&&suspiciousQuestion(q))?'':'disabled'}>🧠 AI sửa câu lỗi</button>`;
   const btnPendingAll=$('btnPendingAll');
   if(btnPendingAll)btnPendingAll.onclick=()=>{
     if(!bank.length)return;
     if(!confirm(`Đưa các câu đủ A/B/C/D và đáp án về PENDING? Câu thiếu dữ liệu sẽ giữ INCOMPLETE.`))return;
     let n=0;bank.forEach(q=>{if(isReviewComplete(q)){q.ReviewStatus='PENDING';n++}else q.ReviewStatus='INCOMPLETE'});
     renderBank();if(editingIndex>=0)openEditor(editingIndex);status(`↩ Đã đưa ${n} câu đủ dữ liệu về PENDING; câu thiếu dữ liệu tự động INCOMPLETE.`);
   };
   const btnVerifyAll=$('btnVerifyAll');
   if(btnVerifyAll)btnVerifyAll.onclick=()=>{
     if(!bank.length)return;
     const candidates=bank.filter(q=>q.ReviewStatus==='PENDING'&&isReviewComplete(q));
     if(!candidates.length){alert('Không có câu PENDING nào đủ Câu hỏi + A/B/C/D + đáp án để xác nhận.');return;}
     if(!confirm(`Xác nhận ${candidates.length} câu PENDING đủ dữ liệu thành VERIFIED?`))return;
     candidates.forEach(q=>{q.ReviewStatus='VERIFIED';q.DataStatus='SOURCE_VERIFIED_BY_USER';q.AnswerStatus='VERIFIED_BY_USER'});
     renderBank();if(editingIndex>=0)openEditor(editingIndex);status(`✅ Đã xác nhận hàng loạt ${candidates.length} câu PENDING thành VERIFIED.`);
   };
   const btnAIRepair=$('btnAIRepair');if(btnAIRepair)btnAIRepair.onclick=aiRepairMissing;
 }
 const rows=$('bankRows');if(!rows)return;
 // Part 5 and Part 7 stay one question per row. Part 6 is grouped by passage.
 const out=[];const emitted=new Set();
 bank.forEach((q,i)=>{
   if(q.Part==='Part 6'){
     const key=q.GroupID||`${q.ActualTest}-P6-${Math.floor((q.CauSo-141)/3)+1}`;
     if(!emitted.has(key)){emitted.add(key);out.push({type:'p6',key,test:q.ActualTest});}
   }else out.push({type:'normal',i,q});
 });
 const groupMap=new Map();
 for(const q of bank.filter(x=>x.Part==='Part 6')){
   const key=q.GroupID||`${q.ActualTest}-P6-${Math.floor((q.CauSo-141)/3)+1}`;
   if(groupMap.has(key))continue;
   const gq=bank.filter(x=>x.Part==='Part 6'&&(x.GroupID||`${x.ActualTest}-P6-${Math.floor((x.CauSo-141)/3)+1}`)===key)
     .sort((a,b)=>Number(a.CauSo)-Number(b.CauSo)).map(x=>({q:x,i:bank.indexOf(x)}));
   groupMap.set(key,gq);
 }
 let html='';
 for(const row of out){
   if(row.type==='p6'){
     const gq=groupMap.get(row.key)||[];const nums=gq.map(x=>x.q.CauSo).join(', ');
     html+=`<tr class="p6-group-row"><td colspan="6"><div class="p6-group"><div class="p6-group-head"><b>📖 ${esc(row.test)} · ${esc(row.key)}</b><span>Câu ${esc(nums)}</span></div><div class="p6-passage"><div class="p6-meta"><b>PASSAGE</b> · Câu ${esc(nums)}</div>${renderP6InlinePassage({qs:gq})}</div></div></td></tr>`;
   }else{
     const q=row.q,i=row.i;
     html+=`<tr data-i="${i}" style="cursor:pointer"><td>${esc(q.ActualTest)}</td><td>${esc(q.Part)}${q.GroupID?'<br><span class="small">'+esc(q.GroupID)+'</span>':''}</td><td><b>${q.CauSo}</b></td><td><b>${esc(q.CauHoi)}</b><br>A. ${esc(q.DapAnA)}<br>B. ${esc(q.DapAnB)}<br>C. ${esc(q.DapAnC)}<br>D. ${esc(q.DapAnD)}</td><td><b>${esc(q.DapAnDung||'—')}</b></td><td class="${q.ReviewStatus==='VERIFIED'?'ok':'bad'}">${esc(q.ReviewStatus)}${q.QualityStatus&&q.QualityStatus!=='PASS'?'<br><span class="small">'+esc(q.QualityStatus)+'</span>':''}</td></tr>`;
   }
 }
 rows.innerHTML=html;
 rows.querySelectorAll('tr[data-i]').forEach(tr=>tr.onclick=()=>openEditor(Number(tr.dataset.i)));
 rows.querySelectorAll('.p6-inline-q[data-i]').forEach(el=>el.onclick=e=>{e.stopPropagation();openEditor(Number(el.dataset.i))});
 const bo=$('btnExportOfficial');if(bo)bo.disabled=!(bank.length&&bank.every(q=>q.ReviewStatus==='VERIFIED'&&/^[ABCD]$/.test(q.DapAnDung||'')));
}
function openEditor(i){editingIndex=i;const q=bank[i];$('editorEmpty').classList.add('hidden');$('editor').classList.remove('hidden');$('eGroup').value=`${q.ActualTest} · ${q.Part}${q.GroupID?' · '+q.GroupID:''}`;$('eNo').value=q.CauSo;$('eAns').value=q.DapAnDung||'';$('eQ').value=q.CauHoi||'';$('eA').value=q.DapAnA||'';$('eB').value=q.DapAnB||'';$('eC').value=q.DapAnC||'';$('eD').value=q.DapAnD||'';$('eExp').value=q.GiaiThich||'';$('editorPreview').textContent=`Trang nguồn: ${q.SourcePageStart}–${q.SourcePageEnd} · ${q.DataStatus} · ${q.ReviewStatus} · ${q.AnswerSource||''}`}
function saveEditor(){if(editingIndex<0)return;const q=bank[editingIndex];q.CauHoi=$('eQ').value.trim();q.DapAnA=$('eA').value.trim();q.DapAnB=$('eB').value.trim();q.DapAnC=$('eC').value.trim();q.DapAnD=$('eD').value.trim();q.DapAnDung=$('eAns').value;q.GiaiThich=$('eExp').value.trim();q.ReviewStatus=isReviewComplete(q)?'PENDING':'INCOMPLETE';renderBank();openEditor(editingIndex);status(`💾 Đã lưu câu ${q.CauSo}.`)}
function verifyEditor(){if(editingIndex<0)return;const q=bank[editingIndex];if(!q.CauHoi||![q.DapAnA,q.DapAnB,q.DapAnC,q.DapAnD].every(Boolean)||!/^[ABCD]$/.test(q.DapAnDung||'')){alert('Cần đủ câu hỏi, A/B/C/D và đáp án đúng trước khi xác nhận.');return}q.ReviewStatus='VERIFIED';q.DataStatus='SOURCE_VERIFIED_BY_USER';q.AnswerStatus='VERIFIED_BY_USER';renderBank();openEditor(editingIndex);status(`✅ Đã xác nhận câu ${q.CauSo}.`)}
function unverifyEditor(){if(editingIndex<0)return;const q=bank[editingIndex];q.ReviewStatus=isReviewComplete(q)?'PENDING':'INCOMPLETE';renderBank();openEditor(editingIndex)}
async function exportZip(official=false){
 if(!bank.length)return;if(official&&!bank.every(q=>q.ReviewStatus==='VERIFIED'&&/^[ABCD]$/.test(q.DapAnDung||''))){alert('Chưa thể xuất chính thức: còn câu chưa xác nhận hoặc thiếu đáp án.');return}
 const zip=new JSZip(),out=JSON.parse(JSON.stringify(bank)),stamp=official?'verified':'draft';zip.file(`TOEIC_BANK_BUILDER_${stamp}.json`,JSON.stringify(out,null,2));zip.file('README_V45.0.0_PARSER_V2_AI.txt',`V45.0.0 TOEIC PDF Parser V2 + AI Repair\n\nPart 5 / Part 6 / Part 7.\nNguồn đề: ${sourceFiles.map(f=>f.name).join(' | ')||''}\nNguồn đáp án: ${$('answerFile')?.files[0]?.name||'không dùng'}\n${official?'Bản đã được người dùng rà soát/xác nhận.':'Bản nháp, cần rà soát.'}\n`);
 if(passageBlobs.size){const folder=zip.folder('TOEIC_PART7_GROUPS');for(const [id,blob] of passageBlobs)folder.file(id.toLowerCase().replace(/-/g,'_')+'.jpg',blob)}
 status('📦 Đang đóng ZIP…');const b=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`V45.0.0_TOEIC_BANK_${stamp}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);status(`✅ Đã xuất ${official?'bản chính thức':'bản nháp'} ZIP.`)
}
async function makePart7Images(){
 // Keep this optional and conservative: only create images for detected Part 7 groups.
 for(const g of groups.filter(x=>x.part==='Part 7')){if(passageBlobs.has(g.id)||!sourcePdf)continue;const pages=pageInfo.filter(p=>p.page>=g.startPage&&p.page<=g.endPage);if(!pages.length)continue;const cs=[];for(const p of pages){const r=await renderPage(p.doc||sourcePdf,p.page,1.05);cs.push(r.canvas)}const w=Math.max(...cs.map(c=>c.width)),h=cs.reduce((n,c)=>n+c.height,0),c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');let y=0;for(const x of cs){ctx.drawImage(x,0,y);y+=x.height}const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',.86));passageBlobs.set(g.id,blob)}
}
function addBuilderUI(){
 const modal=$('toeic-bank-builder-modal');if(!modal)return;
 const first=modal.querySelector('#pdfFile');
 if(first&&!modal.querySelector('#answerFile')){
   first.parentElement.insertAdjacentHTML('afterend','<div class="field" style="flex:2"><label>PDF đáp án riêng <span class="small">(tùy chọn; nếu không chọn, Builder tự đọc Answer Key ở cuối PDF đề)</span></label><input id="answerFile" type="file" accept="application/pdf"></div>');
 }
 const scan=$('btnScan');if(scan)scan.textContent='🔎 Phân tích + ghép đáp án';
 const ocr=$('btnOCR');if(ocr)ocr.textContent='🧠 OCR bổ sung câu thiếu';
 const ans=$('btnAnswers');if(ans)ans.textContent='🔑 Ghép Answer Key';
 const p=modal.querySelector('.builder-content .card .small');if(p)p.innerHTML='Builder cho phép chọn <b>nhiều PDF đề</b>. Nếu PDF đề có Answer Key ở cuối, Builder tự đọc và ghép đáp án; PDF đáp án riêng chỉ là <b>tùy chọn</b>. Tự nhận diện Part 5 (101–140), Part 6 (141–152), Part 7 (153–200), sau đó tự ghép đáp án theo Actual Test.';
 const rule=modal.querySelector('.builder-content .card:last-of-type .small');if(rule)rule.innerHTML='<p>• <b>Parser V2:</b> đọc theo tọa độ PDF, tách cột trước rồi tạo vùng riêng cho từng số câu.</p><p>• Part 5: câu 101–140.</p><p>• Part 6: câu 141–152, tự nhóm 3 câu.</p><p>• Part 7: câu 153–200, nhóm theo chuỗi câu liên tiếp.</p><p>• Có thể chọn nhiều PDF đề; một PDF đáp án chung sẽ được tự động ghép theo Actual Test.</p><p>• Đáp án chấp nhận dạng 101 (B), 101 B, 101. B và OCR B/8, D/0.</p><p>• Câu thiếu/không hợp lệ → <b>INCOMPLETE / REPAIR</b>, không tự đưa vào PENDING.</p><p>• Nút <b>🧠 AI sửa câu lỗi</b> chỉ xử lý các câu nghi ngờ, không cho AI tự bịa phần không nhìn thấy.</p><p>• ZIP xuất ra dùng <b>TOEIC_PART7_GROUPS/</b>.</p>';
 const af=$('answerFile');
 if(af&&!af.dataset.bound){af.dataset.bound='1';af.addEventListener('change',()=>{const f=af.files[0];if(f)status(`🔑 PDF đáp án chung: ${f.name}. Sẽ tự động ghép cho tất cả PDF đề đã chọn.`)});}
}

function bindBuilderEvents(){
 const bind=(id,event,fn)=>{const e=$(id);if(e)e[event]=fn;};
 bind('btnSaveReview','onclick',saveEditor);bind('btnVerify','onclick',verifyEditor);bind('btnUnverify','onclick',unverifyEditor);
 bind('btnExportOfficial','onclick',()=>exportZip(true));bind('btnAnswers','onclick',recognizeAnswers);bind('btnScan','onclick',scan);
 bind('btnStop','onclick',()=>{stopped=true;status('⏹ Đã yêu cầu dừng.')});bind('btnOCR','onclick',ocrAllMissing);
 bind('btnExport','onclick',async()=>{await makePart7Images();await exportZip(false)});
 const pf=$('pdfFile');if(pf&&!pf.dataset.bound){pf.dataset.bound='1';pf.addEventListener('change',async()=>{const fs=[...pf.files];if(!fs.length)return;try{const info=await Promise.all(fs.map(async f=>{const d=await openPdf(f);return `${f.name} (${d.numPages} trang)`;}));status(`📄 Đã chọn ${fs.length} PDF đề: ${info.join(' · ')}`);}catch(e){status('❌ Không mở được PDF đề: '+e.message)}})}
 const af=$('answerFile');if(af&&!af.dataset.bound){af.dataset.bound='1';af.addEventListener('change',()=>{const f=af.files[0];if(f)status(`🔑 PDF đáp án chung: ${f.name}. Bấm “Phân tích + ghép đáp án”.`)})}
}
window.openToeicBankBuilder=function(){const m=document.getElementById('toeic-bank-builder-modal');if(m){m.style.display='flex';document.body.style.overflow='hidden';addBuilderUI();bindBuilderEvents()}};
window.closeToeicBankBuilder=function(){const m=document.getElementById('toeic-bank-builder-modal');if(m){m.style.display='none';document.body.style.overflow=''}};
// Backward-compatible aliases: older main pages used these names for the same builder.
window.openV41ExamGenerator=window.openToeicBankBuilder;
window.openV45BankBuilder=window.openToeicBankBuilder;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindBuilderEvents);else bindBuilderEvents();
window.addEventListener('beforeunload',()=>{if(worker)worker.terminate()});
