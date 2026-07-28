"use strict";

module.exports = {
  async getLights({ homey }) {
    return homey.app.getLightsByZone();
  },

  async setRoles({ homey, body }) {
    return homey.app.setLightRoles(body);
  },
};
