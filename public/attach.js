// Files and pictures attached on the web page: in the chat composer (documents; pictures are addPhotos in app.js) and in a thread's box
// (both). The server decides what it accepts (src/attachments.ts); this only reads them and keeps the sizes sane. app.js mixes this
// into the page's state.
/* eslint-disable no-var */
var ATTACH_FILE_MAX = 4 * 1024 * 1024;
var ATTACH_FILES = 3;
var ATTACH_PICS = 4;
var ATTACH_THREAD = 4; // pictures and files together in one message to a thread (the runner takes at most 4)
var ATTACH_ACCEPT = 'image/*,.pdf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.toml,.log,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.h,.cpp,.sh,.sql,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf';

function attachPage() {
  return {
    docs: [],
    threadPics: [],
    threadDocs: [],
    attachAccept: ATTACH_ACCEPT,
    fileSize(bytes) {
      return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
    },
    async readDoc(file) {
      if (file.size > ATTACH_FILE_MAX) { this.notify('「' + file.name + '」太大了，最多 4 MB'); return null; }
      return { name: file.name, size: file.size, data: base64Of(new Uint8Array(await file.arrayBuffer())) };
    },
    // The chat composer: documents.
    async addDocs(event) {
      var files = Array.prototype.slice.call(event.target.files || []);
      event.target.value = '';
      this.panel = '';
      for (var i = 0; i < files.length && this.docs.length < ATTACH_FILES; i++) {
        try { var doc = await this.readDoc(files[i]); if (doc) this.docs.push(doc); } catch (error) { this.notify('这个文件读不了'); }
      }
      if (files.length > ATTACH_FILES) this.notify('一次最多 ' + ATTACH_FILES + ' 个文件');
    },
    removeDoc(index) { this.docs.splice(index, 1); },
    // A thread's box: pictures and documents from one picker.
    async addThreadFiles(event) {
      var files = Array.prototype.slice.call(event.target.files || []);
      event.target.value = '';
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (this.threadPics.length + this.threadDocs.length >= ATTACH_THREAD) { this.notify('图片和文件一次最多一共 ' + ATTACH_THREAD + ' 个'); break; }
        try {
          if (file.type.indexOf('image/') === 0) {
            if (this.threadPics.length >= ATTACH_PICS) { this.notify('一次最多 ' + ATTACH_PICS + ' 张图'); continue; }
            var blob = file.type === 'image/gif' && file.size < 3.5 * 1024 * 1024 ? file : await shrinkPicture(file, 1568, false);
            this.threadPics.push({ url: URL.createObjectURL(blob), data: base64Of(new Uint8Array(await blob.arrayBuffer())) });
          } else if (this.threadDocs.length >= ATTACH_FILES) {
            this.notify('一次最多 ' + ATTACH_FILES + ' 个文件');
          } else {
            var doc = await this.readDoc(file);
            if (doc) this.threadDocs.push(doc);
          }
        } catch (error) { this.notify('这个文件读不了'); }
      }
    },
    removeThreadPic(index) { this.threadPics.splice(index, 1); },
    removeThreadDoc(index) { this.threadDocs.splice(index, 1); },
    threadCanSay() {
      return Boolean(this.threadDraft.trim() || this.threadPics.length || this.threadDocs.length);
    }
  };
}
