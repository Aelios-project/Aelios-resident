// Optional role packs use the existing role save API and its validation and limit.
function recommendedRolesPage() {
  return {
    recommendedRoleInstalled(role) {
      return this.cloud.roles.some(function (saved) { return saved.name === role.name; });
    },
    recommendedRoleFull() {
      return this.cloud.roles.length >= (this.cloud.rolesMax || 12);
    },
    async installRecommendedRole(role) {
      if (this.roleBusy || this.roleEdit || this.recommendedRoleFull() || this.recommendedRoleInstalled(role)) return;
      this.roleBusy = true;
      this.roleError = '';
      try {
        var saved = await this.api('/web/tasks/roles', { method: 'POST', body: { name: role.name, template: role.template, model: role.model } });
        this.cloud.roles = saved.roles;
      } catch (error) {
        this.roleError = error.message;
      } finally {
        this.roleBusy = false;
      }
    }
  };
}
