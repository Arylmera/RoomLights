"use strict";

module.exports = {
  async getLights({ homey }) {
    return homey.app.getLightsByZone();
  },

  async setRoles({ homey, body }) {
    return homey.app.setLightRoles(body);
  },

  async getDefaults({ homey }) {
    return homey.app.getRoomDefaultsPage();
  },

  async setDefaults({ homey, body }) {
    return homey.app.setRoomDefaults(body);
  },
};
