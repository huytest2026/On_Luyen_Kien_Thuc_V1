V18.3 – Curated Exact-form Translation Patch

Load AFTER v17-dictionary.js.

index.html:
<script src="script.js"></script>
<script src="v17-dictionary.js"></script>
<script src="v18.3-dictionary.js"></script>

V17 remains the main dictionary engine. V18.3 only patches the Vietnamese
summary for curated exact forms. POS, examples, synonyms, Word Family,
IPA, audio and pronunciation checking remain provided by V17.

Replace v18.2-dictionary.js with v18.3-dictionary.js; do not remove
v17-dictionary.js.
