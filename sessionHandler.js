'use strict';

const assert = require('assert');
const ApiAiAssistant = require('actions-on-google').ApiAiAssistant;
const CircuitClient = require('./circuitClient');
const log = require('./logger').child({module: 'sessionHandler'});
const config = require('./config.json');

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5min session timeout
let sessions = {}; // Active sessions

/**
 * clearSession
 */
function clearSession(sessionId) {
  let session = sessions[sessionId];
  if (!session) {
    return Promise.resolve();
  }
  log.info(`Clearing session ${sessionId}`);
  clearTimeout(session.timer);
  session.timer = null;
  sessions[sessionId] = null;
  return session.circuit.logout();
}

/**
 * destroy
 */
function destroy() {
  let promises = [];
  Object.keys(sessions).forEach(key => promises.push(clearSession(key)));
  sessions = [];
  return Promise.all(promises);
}

/**
 * Ctrl+C
 */
process.on('SIGINT', _ => {
  log.info('SIGINT received. Clear sessions and log users out.');
  destroy();
});

module.exports = function(options) {
  return function(req, res, next) {
    const sessionId = req.body.sessionId;
    const assistant = new ApiAiAssistant({request: req, response: res});
    const isDev = process.env.NODE_ENV === 'development';
    let circuit;

    if (!sessions[sessionId]) {
      // Create session and logon to Circuit while welcome intent is running
      const user = isDev ? {} : assistant.getUser();
      assert(user, `Running in production mode without OAuth linking enabled`);
      circuit = new CircuitClient(isDev ? config.dev.oauth : {client_id: config.oauth});
      circuit.logon(user.access_token)
        .then(() => {
          sessions[sessionId] = {
            circuit: circuit,
            timer: setTimeout(clearSession.bind(null, sessionId), SESSION_TIMEOUT)
          }
        })
        .catch(err => log.error(`Unable to logon to Circuit`, err));
    } else {
      // Renew session timer
      const session = sessions[sessionId];
      clearTimeout(session.timer);
      session.timer = setTimeout(clearSession.bind(null, sessionId), SESSION_TIMEOUT);
      circuit = session.circuit;
    }
    req.circuit = circuit;
    next();
  }
}