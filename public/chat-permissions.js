// Chat and Waiting answer the same live permission, never a saved chat message.
function chatPermissionsPage() {
  return {
    chatPermissions: [],
    syncChatPermissions(data) {
      this.chatPermissions = data && Array.isArray(data.permissions) ? data.permissions : [];
      if (this.waitList) {
        this.waitList.items = this.waitList.items.filter(function (item) { return item.kind !== 'permission'; }).concat(this.chatPermissions);
        this.waitList.open = this.waitList.items.length;
      }
    },
    chatPermissionRows() {
      return this.chatPermissions.map(function (item) { return { key: 'permission_' + item.perm, type: 'permission', permission: item }; });
    },
    async answerChatPermission(item, allow) {
      await this.waitingPermission(item, allow);
      await this.refresh(true);
    }
  };
}
