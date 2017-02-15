/*
    Copyright (c) 2017 Unify Inc.

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the "Software"),
    to deal in the Software without restriction, including without limitation
    the rights to use, copy, modify, merge, publish, distribute, sublicense,
    and/or sell copies of the Software, and to permit persons to whom the Software
    is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
    OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
    OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

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
    let sessionId = req.body.sessionId;
    let assistant = new ApiAiAssistant({request: req, response: res});
    let isDev = process.env.NODE_ENV === 'development';
    let circuit = null;

    if (!sessions[sessionId]) {
      // Create session and logon to Circuit while welcome intent is running
      let user = isDev ? {} : assistant.getUser();
      assert(user, `Running in production mode without OAuth linking enabled`);
      circuit = new CircuitClient(isDev ? config.dev.oauth : {client_id: config.oauth});
      circuit.logon(user.access_token)
      .then(_ => {
        sessions[sessionId] = {
          circuit: circuit,
          timer: setTimeout(clearSession.bind(null, sessionId), SESSION_TIMEOUT)
        }
      })
      .catch(err => log.error(`Unable to logon to Circuit`, err));
    } else {
      // Renew session timer
      let session = sessions[sessionId];
      clearTimeout(session.timer);
      session.timer = setTimeout(clearSession.bind(null, sessionId), SESSION_TIMEOUT);
      circuit = session.circuit;
    }
    req.circuit = circuit;
    next();
  }
}