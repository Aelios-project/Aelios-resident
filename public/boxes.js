// The boxes on the settings page (src/box-routes.ts, acp-box/): a one-time pairing code, the paired boxes with the
// plugs they offer, online or not, last seen, which one serves a plug when two offer it, and Revoke. app.js mixes this
// into the page's state. The helpers' keys are never here: they stay on the box's machine.
function boxesPage() {
  return {
    boxes: { loaded: false, list: [], code: '', expiresAt: 0, busy: false, error: '', timer: null, noteSeen: localStorage.getItem('boxKeysNote') === '1' },
    async loadBoxes() {
      try {
        var data = await this.api('/web/boxes');
        this.boxes = Object.assign({}, this.boxes, { loaded: true, list: data.boxes, error: '' });
      } catch (error) { this.boxes.error = error.message; }
    },
    async boxesCode() {
      this.boxes.busy = true; this.boxes.error = '';
      try {
        var data = await this.api('/web/boxes/code', { method: 'POST', body: {} });
        this.boxes.code = data.code; this.boxes.expiresAt = data.expiresAt;
        this.watchBoxes();
      } catch (error) { this.boxes.error = error.message; }
      this.boxes.busy = false;
    },
    // After a code is made, look again every few seconds until a new box shows or the code has run out.
    watchBoxes() {
      var self = this;
      var before = this.boxes.list.length;
      clearInterval(this.boxes.timer);
      this.boxes.timer = setInterval(async function () {
        if (!self.boxes.code || Date.now() > self.boxes.expiresAt + 30000) { clearInterval(self.boxes.timer); return; }
        await self.loadBoxes();
        if (self.boxes.list.length > before) { clearInterval(self.boxes.timer); self.boxes.code = ''; }
      }, 3000);
    },
    async boxRevoke(box) {
      if (!confirm('撤销「' + box.name + '」？它马上断开，在它上面跑的这一轮会停。')) return;
      this.boxes.busy = true; this.boxes.error = '';
      try {
        await this.api('/web/boxes/revoke', { method: 'POST', body: { id: box.id } });
        await this.loadBoxes();
      } catch (error) { this.boxes.error = error.message; }
      this.boxes.busy = false;
    },
    // Two boxes offer the same plug: pick the one that serves it ('' goes back to the newest connected).
    async boxServe(plug, id) {
      this.boxes.error = '';
      try {
        await this.api('/web/boxes/serve', { method: 'POST', body: { plug: plug, id: id } });
        await this.loadBoxes();
      } catch (error) { this.boxes.error = error.message; }
    },
    boxState(box) {
      if (box.online) return '在线';
      return '不在线' + (box.lastSeenAt ? '（上次 ' + this.fmt(box.lastSeenAt) + '）' : '（还没连上过）');
    },
    // The plugs that more than one paired box offers, with the boxes that offer them.
    boxChoices() {
      var by = {};
      this.boxes.list.forEach(function (box) { box.plugs.forEach(function (plug) { (by[plug] = by[plug] || []).push(box); }); });
      return Object.keys(by).filter(function (plug) { return by[plug].length > 1; }).map(function (plug) {
        var serving = by[plug].find(function (box) { return box.serves.indexOf(plug) >= 0; });
        return { plug: plug, boxes: by[plug], serving: serving ? serving.id : '' };
      });
    },
    boxCommand() {
      var resident = this.resident && this.resident !== 'default' ? '/r/' + this.resident : '';
      return 'node main.mjs --resident ' + location.origin + resident + ' --code ' + this.boxes.code;
    },
    boxNoteDone() {
      localStorage.setItem('boxKeysNote', '1');
      this.boxes.noteSeen = true;
    }
  };
}
