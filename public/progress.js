// What a thread on their machine is doing right now (src/thread-steps.ts): the last three steps on its row and on its page
// while it works. app.js mixes this into the page's state, so no name here may be one app.js already has.
function progressPage() {
  var timer = 0;
  return {
    // The newest three steps of a thread card or a thread page, or none.
    progressLines(item) {
      return item && Array.isArray(item.steps) ? item.steps.slice(-3) : [];
    },
    // The threads list does not reload by itself: while it is open and something works, look again now and then.
    progressWatch(view) {
      clearInterval(timer);
      if (view !== 'threads') return;
      var self = this;
      timer = setInterval(async function () {
        if (document.hidden || self.view !== 'threads') return;
        if (!self.threads.threads.some(function (t) { return t.status === 'working' && t.runs === 'machine'; })) return;
        try {
          var data = await self.api('/web/threads');
          self.threads = { loaded: true, on: Boolean(data.on), threads: data.threads || [] };
        } catch (error) { /* the list stays as it was */ }
      }, 5000);
    }
  };
}
