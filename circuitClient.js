'use strict';

const bunyan = require('bunyan');
const Circuit = require('circuit-sdk');
const Fuse = require('fuse.js');
const log = require('./logger').child({module: 'circuit'});
const config = require('./config.json');

let sdkLogLevel = config.logging && config.logging.circuitsdk || 'error';

/**
 * Wrapper class for Circuit.Client
 */
class CircuitClient {
  constructor (credentials) {
    this.usersHT = {};

    // Create client instance
    this.client = new Circuit.Client(credentials);

    // Create fuse instance
    this.fuse = new Fuse([], {
      threshold: 0.3,
      keys: ['firstName', 'lastName', 'displayName'],
      id: 'userId'
    });

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
    this.search = this.fuse.search.bind(this.fuse);
    this.sendClickToCallRequest = this.client.sendClickToCallRequest;
    this.getStartedCalls = this.client.getStartedCalls;
    this.getConversationById = this.client.getConversationById;
    this.getDevices = this.client.getDevices;
    this.joinConference = this.client.joinConference;

    // Properties
    Object.defineProperty(this, 'user', {
      get: _ => { return this.client.loggedOnUser; }
    });

    Object.defineProperty(this, 'users', {
      get: _ => { return this.usersHT; }
    });
  }


  /////////////////////////////////////
  /// Private functions
  /////////////////////////////////////

  /**
   * logon
   */
  logon (accessToken) {
    return this.client.logon(accessToken ? {accessToken: accessToken} : undefined)
    .then(user => log.info(`Logged on to Circuit: ${user.displayName}`))
    .then(this._retrieveUsers.bind(this));
  }

  /**
   * logout
   */
  logout() {
    if (!this.client) {
      return Promise.resolve();
    }
    let displayName = this.client.loggedOnUser.displayName;
    return this.client.logout()
    .then(_ => {
      log.info(`Logged out of Circuit: ${displayName}`)
    })
  }

  /**
   * sendMessage
   */
  sendMessage(userId, text) {
    return this.client.getDirectConversationWithUser(userId)
    .then(c => {
      return this.client.addTextItem(c.convId, text);
    });
  }

  /**
   * searchByDisplayName
   */
  searchByDisplayName(query, list) {
    let fuse = new Fuse(list, {
      threshold: 0.3,
      keys: ['displayName'],
      id: 'userId'
    });
    return fuse.search(query);
  }

  /////////////////////////////////////
  /// Private functions
  /////////////////////////////////////

  // Helper function to retrieve up to 50 users of most recent conversations
  _retrieveUsers () {
    return this.client.getConversations({numberOfConversations: 50})
    .then(convs => {
      let userIds = [];
      convs = convs.sort((a, b) => {
        return a.participants.length - b.participants.length;
      });
      convs.forEach(c => {
        c.participants.forEach(p => {
          if (userIds.indexOf(p) === -1) {
            userIds.push(p);
          }
        });
      });
      userIds.splice(userIds.indexOf(this.client.loggedOnUser.userId), 1);
      userIds = userIds.slice(0, Math.min(userIds.length, 50));
      return userIds;
    })
    .then(this.client.getUsersById)
    .then(users => {
      return users.filter(u => {
        // Exclude test accounts that use mailinator email addresses
        return u.emailAddress.indexOf('mailinator.com') === -1;
      });
    })
    .then(users => {
      let fuseData = [];
      users.forEach(u => this.usersHT[u.userId] = u);
      this.fuse.set(users);
      log.info(`Retrieved ${users.length} users`);
    });
  }
}

module.exports = CircuitClient;