// Preloaded into kit/dashboard/server.js by serve.js (node --import), for both builds alike. The server computes each
// lane's wall time from its own clock (kitlib storeClock, shown since #126 as "0.0h"), so captures of the two builds
// made minutes apart would differ in that text alone. This starts the server's clock at PARITY_NOW, the instant the
// browser's clock is frozen at (helpers.js NOW); from there it runs at the normal rate, so nothing that measures an
// interval changes.
const start = Number(process.env.PARITY_NOW);
if (Number.isFinite(start) && start > 0) {
  const RealDate = Date;
  const shift = start - RealDate.now();
  class ParityDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ParityDate;
}
