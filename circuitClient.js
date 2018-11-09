'use strict';

const bunyan = require('bunyan');
const Circuit = require('circuit-sdk');
const log = require('./logger').child({module: 'circuit'});
const config = require('./config.json');

let sdkLogLevel = config.logging && config.logging.circuitsdk || 'error';

/**
 * Wrapper class for Circuit.Client
 */
class CircuitClient {
  constructor (credentials) {
    // Create client instance
    this.client = new Circuit.Client(credentials);

    Circuit.setLogger(bunyan.createLogger({
        name: 'sdk',
        stream: process.stdout,
        level: sdkLogLevel
    }));

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
    this.sendClickToCallRequest = this.client.sendClickToCallRequest;
    this.getStartedCalls = this.client.getStartedCalls;
    this.getConversationsByIds = this.client.getConversationsByIds;
    this.getDevices = this.client.getDevices;
    this.joinConference = this.client.joinConference;
    this.getDirectConversationWithUser = this.client.getDirectConversationWithUser;
    this.addTextItem = this.client.addTextItem;

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
        console.log('searchStatus', evt)
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

  /**
   * logon
   */
  logon (accessToken) {
    return this.client.logon(accessToken ? {accessToken: accessToken} : undefined)
      .then(user => log.info(`Logged on to Circuit: ${user.displayName}`))
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
        log.info(`Logged out of Circuit: ${displayName}`)
      });
  }

  /////////////////////////////////////
  /// Private functions
  /////////////////////////////////////

}

module.exports = CircuitClient;