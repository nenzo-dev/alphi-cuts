// Runs before the page is drawn (a plain script at the top of each page). On a device with no real
// graphics chip (an emulator, or a browser drawing everything in software), the moving 3D ring, the
// blur and the animations are left out: drawn in software they can stall the whole device.
// fx.js and css/style.css (html.fx-soft) do the rest.
(function () {
  var soft = /sdk_gphone|sdk_x86|Android SDK built for|generic_x86|Emulator/i.test(navigator.userAgent);
  if (!soft) {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      soft = /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
      var lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (e) {
      soft = false;
    }
  }
  if (soft) document.documentElement.classList.add('fx-soft', 'fx-lite');
})();
