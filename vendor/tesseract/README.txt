Tesseract.js 5.1.1 (Apache-2.0), served from this site so the page can read payment screenshots
on the client's own phone without sending the picture to a third party.

  tesseract.min.js, worker.min.js         tesseract.js@5.1.1 (dist)
  tesseract-core-simd-lstm.wasm.js        tesseract.js-core@5.1.1 (phones with WebAssembly SIMD)
  tesseract-core-lstm.wasm.js             tesseract.js-core@5.1.1 (the rest)
  eng.traineddata.gz                      @tesseract.js-data/eng@1.0.0, 4.0.0_best_int (English)

Loaded on demand by js/lib/proof.js, only when a client picks a payment screenshot.
