// Run with Node.js after you provide/prepare a validated word source.
// It copies the existing 50K shards and is the place to merge additional entries.
const fs=require('fs'), path=require('path');
const src='dictionary-50k', dst='dictionary-200k/core';
fs.mkdirSync(dst,{recursive:true});
for(const name of fs.readdirSync(src)){ if(name.endsWith('.json')) fs.copyFileSync(path.join(src,name),path.join(dst,name)); }
console.log('Copied current 50K shards. Add validated entries, de-duplicate, then write by first letter.');
