V34 dictionary-200k structure

1. Copy existing dictionary-50k/a.json ... z.json and other.json into dictionary-200k/core/.
2. Keep the same object format.
3. The V34 script lazy-loads only the needed shard.
4. Do NOT delete dictionary-50k until the new 200K corpus has been populated and tested.
5. This package provides the 200K architecture; the actual additional 150K validated entries require a licensed/open word-data source and a build step.
