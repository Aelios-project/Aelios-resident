// The waiting list on the 线程 page (src/waiting.ts): only what needs their decision or action, in one fixed format; news (a thread
// finished, a note) is a dot on the thread's row instead. It is read from its own endpoint and never touches the conversation. app.js mixes this into the page's state, so no name here may be
// one app.js already has (app.js has waiting(), the typing dots).
function waitingPage() {
  return {
    waitList: { items: [], open: 0, unread: {} },
    async loadWaiting() {
      try { this.waitList = await this.api('/web/waiting'); } catch (error) { /* the threads below still work */ }
    },
    waitingKind(item) {
      return item.kind === 'stuck' ? '卡住了' : item.kind === 'permission' ? '要你点头' : '等你';
    },
    // An option goes the way a choice on a thread's card goes.
    async waitingAnswer(item, option) {
      if (this.choosing) return;
      this.choosing = item.task;
      try {
        await this.api('/web/task/choose', { method: 'POST', body: { id: item.task, text: option } });
        await this.loadWaiting();
      } catch (error) { this.notify(error.message); }
      this.choosing = '';
    },
    // Allow / Deny on a permission the machine holds: only this button answers it.
    async waitingPermission(item, allow) {
      if (this.choosing) return;
      this.choosing = item.id;
      try { this.waitList = await this.api('/web/waiting/permission', { method: 'POST', body: { id: item.perm, allow: allow } }); }
      catch (error) { this.notify(error.message); await this.loadWaiting(); }
      this.choosing = '';
    },
    // Opening a thread reads its news.
    async waitingRead(threadId) {
      if (!this.waitList.unread || !this.waitList.unread[threadId]) return;
      try { this.waitList = await this.api('/web/waiting/seen', { method: 'POST', body: { id: threadId } }); } catch (error) { /* the dot stays */ }
    },
    unreadOf(threadId) {
      return (this.waitList.unread && this.waitList.unread[threadId]) || 0;
    },
    // A stuck item put aside: it comes back only if the thread fails again.
    async waitingDismiss(item) {
      try { this.waitList = await this.api('/web/waiting/seen', { method: 'POST', body: { item: item.id } }); } catch (error) { this.notify(error.message); }
    },
    // The one button on a stuck item: the settings page, or the thread (where a permission is given).
    waitingAct(item) {
      return item.action === 'settings' ? this.openSettings() : this.openThread(item.thread);
    },
    async stopThread() {
      if (this.threadBusy) return;
      this.threadBusy = true;
      try {
        await this.api('/web/thread/stop', { method: 'POST', body: { id: this.thread.id } });
        this.notify('叫它停下了');
      } catch (error) { this.notify(error.message); }
      this.threadBusy = false;
    }
  };
}
