/* V18 – Exact-form Dictionary Patch
   Load AFTER v17-dictionary.js. Keeps V17 UI/features intact. */
(function(){
"use strict";
const V18="v18-exact-form-translation";
const ROOTS={children:"child",people:"person",men:"man",women:"woman",mice:"mouse",geese:"goose",feet:"foot",teeth:"tooth",better:"good",best:"good",worse:"bad",worst:"bad",went:"go",gone:"go",seen:"see",given:"give",taken:"take",written:"write",spoken:"speak",postponed:"postpone",advised:"advise",worked:"work"};
const VI={children:"trẻ em; con cái",people:"mọi người; người dân",men:"đàn ông; nam giới",women:"phụ nữ; nữ giới",mice:"những con chuột",geese:"những con ngỗng",feet:"bàn chân; chân",teeth:"răng",better:"tốt hơn",best:"tốt nhất",worse:"tệ hơn; xấu hơn",worst:"tệ nhất",went:"đã đi",gone:"đã đi; đã biến mất",seen:"đã nhìn thấy",given:"đã cho",taken:"đã lấy; đã mang",written:"đã viết",spoken:"đã nói",postponed:"hoãn lại",advised:"đã khuyên; được khuyên",worked:"đã làm việc; đã hoạt động",beautiful:"xinh đẹp; đẹp",advice:"lời khuyên; sự khuyên bảo",work:"công việc; việc làm; làm việc; hoạt động",small:"nhỏ; bé",concentrate:"tập trung",beach:"bãi biển",corridor:"hành lang"};
function n(x){return String(x||"").trim().toLowerCase().replace(/\s+/g," ");}
function save(w,t){try{localStorage.setItem("dict-v18-"+w,JSON.stringify({translation:t,version:V18,savedAt:Date.now()}));}catch(e){}}
function cached(w){try{return JSON.parse(localStorage.getItem("dict-v18-"+w)||"{}").translation||"";}catch(e){return"";}}
async function translate(w){
 let t=cached(w)||VI[w]; if(t){save(w,t);return t;}
 if(!navigator.onLine)return"";
 const c=new AbortController(),tm=setTimeout(()=>c.abort(),4500);
 try{let r=await fetch("https://api.mymemory.translated.net/get?q="+encodeURIComponent(w)+"&langpair=en|vi",{signal:c.signal});if(!r.ok)return"";
 let d=await r.json(),x=String(d?.responseData?.translatedText||"").trim();
 if(x&&n(x)!==w){save(w,x);return x;}return"";
 }catch(e){return""}finally{clearTimeout(tm);}
}
function slot(root){
 for(const e of root.querySelectorAll("div,p,span"))if(/VN\s*Nghĩa tiếng Việt/i.test((e.textContent||"").replace(/\s+/g," ")))return e.parentElement||e;
 return null;
}
function apply(root,w,t){
 let s=slot(root);if(!s||!t)return;
 let b=[...s.querySelectorAll("b,strong")].find(e=>/Nghĩa tiếng Việt/i.test(e.textContent||""));
 if(b){let h=b.parentElement;let nodes=[...h.childNodes].filter(x=>x!==b);let tn=nodes.find(x=>x.nodeType===3);if(tn){tn.textContent=" "+t;return;}}
 let old=s.querySelector(".v18-exact");if(old)old.remove();
 let sp=document.createElement("span");sp.className="v18-exact";sp.textContent=t;sp.style.display="block";sp.style.marginTop="4px";s.appendChild(sp);
}
async function enrich(w){
 let input=document.getElementById("dict-input"),box=document.getElementById("dict-result");
 if(!box||n(input?.value)!==w)return;
 let t=await translate(w);if(n(input?.value)!==w||!t)return;
 apply(box,w,t);box.dataset.v18=V18;
}
function install(){
 if(window.__V18_DICTIONARY_INSTALLED__)return;
 window.__V18_DICTIONARY_INSTALLED__=true;
 const wait=()=>{if(typeof window.lookupWord!=="function"){setTimeout(wait,200);return;}
 const old=window.lookupWord;if(old.__v18Wrapped)return;
 async function wrapped(q){const input=document.getElementById("dict-input"),w=n(q||input?.value||"");const r=await old.apply(this,arguments);if(w){setTimeout(()=>enrich(w),100);setTimeout(()=>enrich(w),800);}return r;}
 wrapped.__v18Wrapped=true;window.lookupWord=wrapped;
 console.info("[Dictionary V18] Exact-form translation ready.");
 };wait();
}
window.DictionaryV18={version:V18,getRootWord:w=>ROOTS[n(w)]||n(w),getOfflineVietnamese:w=>VI[n(w)]||""};
install();
})();