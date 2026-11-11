// Chat and Waiting answer the same live permission, never a saved chat message.
function chatPermissionsPage() {
  return {
    chatPermissions: [],
    syncChatPermissions(data) {
      this.chatPermissions = data && Array.isArray(data.permissions) ? data.permissions : [];
      if (data && data.waiting) this.waitList = data.waiting;
      if (!data) this.waitList = { items: [], open: 0, unread: {} };
    },
    chatPermissionRows() {
      return this.chatPermissions.map(function (item) { return { key: 'permission_' + (item.perm || item.id), type: 'permission', permission: item }; });
    },
    async answerChatPermission(item, allow) {
      if (item.perm) await this.waitingPermission(item, allow);
      else await this.waitingAnswer(item, allow ? 'Allow' : 'Deny');
      await this.refresh(true);
    }
  };
}
