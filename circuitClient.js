'use strict';

const Circuit = require('circuit-sdk');

/**
 * Wrapper class for Circuit.Client
 */
class CircuitClient {
  constructor(credentials) {
    // Create client instance
    this.client = new Circuit.Client(credentials);

    // Add peerUserId attribute for direct conversations
    Circuit.Injectors.conversationInjector = c => {
      if (c.type === 'DIRECT') {
        c.peerUserId = c.participants.filter(userId => {
          return userId !== this.client.loggedOnUser.userId;
        })[0];
      }
      return c;
    }

    // Function bindings
    this.addParticipant = this.client.addParticipant;
    this.addTextItem = this.client.addTextItem;
    this.getConversationsByIds = this.client.getConversationsByIds;
    this.getDevices = this.client.getDevices;
    this.getDirectConversationWithUser = this.client.getDirectConversationWithUser;
    this.getPresence = this.client.getPresence;
    this.getStartedCalls = this.client.getStartedCalls;
    this.joinConference = this.client.joinConference;
    this.removeParticipant = this.client.removeParticipant;
    this.sendClickToCallRequest = this.client.sendClickToCallRequest;
    this.setPresence = this.client.setPresence;

    // Properties
    Object.defineProperty(this, 'user', {
      get: _ => { return this.client.loggedOnUser; }
    });
  }

  /////////////////////////////////////
  /// Public functions
  /////////////////////////////////////

  async searchUsers (query) {
    const self = this;
    return new Promise(async resolve => {
      let searchId;
      let userIds;

      function searchResultHandler(evt) {
        if (evt.data.searchId !== searchId) {
          return;
        }
        if (!evt.data.users || !evt.data.users.length) {
          return;
        }
        userIds = evt.data.users;
      }

      async function searchStatusHandler(evt) {
        // Indicates is search is finished
        if (evt.data.searchId !== searchId) {
          return;
        }
        if (evt.data.status === 'FINISHED' || evt.data.status === 'NO_RESULT') {
          self.client.removeEventListener('basicSearchResults', searchResultHandler);
          self.client.removeEventListener('searchStatus', searchResultHandler);
          if (userIds) {
            resolve(await self.client.getUsersById(userIds));
          } else {
            resolve([]);
          }
        }
      }

      self.client.addEventListener('basicSearchResults', searchResultHandler);
      self.client.addEventListener('searchStatus', searchStatusHandler);

      searchId = await self.client.startUserSearch(query);
    });
  }

  async searchConversationsByName(query) {
    const self = this;
    return new Promise(async resolve => {
      let searchId;
      let convIds;

      function searchResultHandler(evt) {
        if (evt.data.searchId !== searchId) {
          return;
        }
        if (!evt.data.searchResults || !evt.data.searchResults.length) {
          return;
        }
        console.log('basicSearchResults', evt);
        convIds = evt.data.searchResults.filter(c => c.convId).map(c => c.convId);
      }

      async function searchStatusHandler(evt) {
        // Indicates is search is finished
        console.log('searchStatus', evt);
        if (evt.data.searchId !== searchId) {
          return;
        }
        if (evt.data.status === 'FINISHED' || evt.data.status === 'NO_RESULT') {
          self.client.removeEventListener('basicSearchResults', searchResultHandler);
          self.client.removeEventListener('searchStatus', searchResultHandler);
          if (convIds) {
            resolve(await self.client.getConversationsByIds(convIds));
          } else {
            resolve([]);
          }
        }
      }

      self.client.addEventListener('basicSearchResults', searchResultHandler);
      self.client.addEventListener('searchStatus', searchStatusHandler);

      searchId = await self.client.startBasicSearch([{
        scope: Circuit.Enums.SearchScope.CONVERSATIONS,
        searchTerm: query
      }]);
    });
  }

  async setPresenceAvailable() {
    const statusMsg = await this.client.getStatusMessage();
    try {
      return this.client.setPresence({
        state: Circuit.Enums.PresenceState.AVAILABLE,
        statusMessage: statusMsg
      });
    } catch (e) {
        console.log('Could not set user to available', e);
    }
  }
  
  async setPresenceDnd(untilTime, duration) {
    const statusMsg = await this.client.getStatusMessage();
    if (untilTime !== '') {
      untilTime = new Date(untilTime).getTime();
      return this.client.setPresence({
        state: Circuit.Enums.PresenceState.DND,
        dndUntil: untilTime,
        statusMessage: statusMsg
      });
    } else if (duration !== '') {
        if (duration.unit === 'min') {
          return this.client.setPresence({
            state: Circuit.Enums.PresenceState.DND,
            dndUntil: Date.now() + (60000 * duration.amount), //sets to 1 minute in ms * amount of minutes
            statusMessage: statusMsg
          });
        } else if (duration.unit === 'h') {
          return this.client.setPresence({
            state: Circuit.Enums.PresenceState.DND,
            dndUntil: Date.now() + (3600000 * duration.amount), //sets to 1 hour in ms * amount of hours
            statusMessage: statusMsg
          });
        } else {
          console.log('User has not entered a time in hours or minutes. Presence cannot be set.');
        } 
    }
  }

  getDndTime() {
    return this.client.getPresence(this.user.userId)
      .then(res => res[0].dndUntil)
      .catch(console.error);
  }

  getUserPresence() {
    return this.client.getPresence(this.user.userId)
      .then(res => res[0].state)
      .catch(console.error);
  }

  /**
   * logon
   */
  logon (accessToken) {
    return this.client.logon(accessToken ? { accessToken: accessToken } : undefined)
      .then(user => console.log(`Logged on to Circuit: ${user.displayName}`));
  }

  /**
   * logout
   */
  logout() {
    if (!this.client) {
      return Promise.resolve();
    }
    const displayName = this.client.loggedOnUser.displayName;
    return this.client.logout()
      .then(_ => {
        console.log(`Logged out of Circuit: ${displayName}`);
      });
  }

  /////////////////////////////////////
  /// Private functions
  /////////////////////////////////////
}

module.exports = CircuitClient;
