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

const util = require('util');
const ApiAiAssistant = require('actions-on-google').ApiAiAssistant;
const log = require('./logger').child({module: 'va'});

function init(app) {
  log.info(`Initialize va routes`);

  app.post('/', (req, res) => {
    log.trace('Request:', util.inspect(req.body, false, 5));
    const assistant = new ApiAiAssistant({request: req, response: res});
    const sessionId = req.body.sessionId;
    let circuit = req.circuit;

    // Argument names
    const NAME_ARGUMENT = 'name';
    const TEXT_ARGUMENT = 'text';
    const USER_ID_ARGUMENT = 'userId';

    // Common intents and contexts
    const WELCOME_INTENT = 'welcome';
    const FIND_USER_INTENT = 'find.user';
    const TRY_AGAIN = 'try-again';
    const USER_SPECIFY_CONTEXT = 'user-specify';
    const USER_CONFIRM_CONTEXT = 'user-confirm';
    
    // Call user intents and context
    const CALL_USER_INITIATE_INTENT = 'call.user.initiate';
    const CALL_USER_SPECIFY_INTENT = 'call.user.specify';
    const CALL_USER_CONTEXT = 'call-user';

    // Send message intents and context
    const SEND_MESSAGE_CONFIRM_TEXT_INTENT = 'send.message.confirm.text';
    const SEND_MESSAGE_SPECIFY_INTENT = 'send.message.specify';
    const SEND_MESSAGE_SEND_INTENT = 'send.message.send';
    const SEND_MESSAGE_CONTEXT = 'send-message';
    const SEND_MESSAGE_CONFIRM_CONTEXT = 'send-message-confirm';

    // Join conference intents and context
    const MEETINGS_LIST_INTENT = 'meetings.list';
    const MEETING_JOIN_INTENT = 'meeting.join';


    /**************************************************/
    /* Common Intents                                 */
    /**************************************************/
    function sendWelcomeIntent() {
      // Handle this in node so that a circuit client can be created and users fetched
      assistant.ask(`Hi, I'm your Circuit Assistant. What would you like to do?`);
    }
  
    /**
     * Find a user and handle finding none, 1, 2-4 or more users.
     * Function is context aware and used for different use cases.
     */
    function findUserIntent(assistant) {
      let name = assistant.getArgument(NAME_ARGUMENT);
      log.info(`[${FIND_USER_INTENT}] name: ${name}`);

      let contexts = assistant.getContexts().map(c => { return c.name; });
      let isSendMessageContext = contexts.indexOf(SEND_MESSAGE_CONTEXT) >= 0;
      let isCallUserContext = contexts.indexOf(CALL_USER_CONTEXT) >= 0;

      let user;
      let matches = circuit.search(name);
      if (matches.length === 0) {
        assistant.setContext(TRY_AGAIN);
        assistant.ask(`Could not find user ${name}. Would you like to try again?`);
      } else if (matches.length === 1) {
        user = circuit.users[matches[0]];
        assistant.data.userId = user.userId;
        assistant.setContext(USER_CONFIRM_CONTEXT, 1, {user: user.displayName});
        let ask = `Found ${user.displayName}.`;
        if (isSendMessageContext) {
          ask += ` Would you like to start the call?`;
        } else if (isCallUserContext) {
          ask += ` Is this correct?`;
        }
        assistant.ask(ask);
      } else  if (matches.length <= 4) {
        assistant.setContext(USER_SPECIFY_CONTEXT);
        let users = matches.map(m => { return circuit.users[m]; });
        assistant.data.usermatches = users;
        let ask = `Found `;
        let firstUsers = users.slice(0, users.length - 1).map(u => {return u.displayName;});
        ask += firstUsers.join(', ');
        ask += ` and ${users[users.length - 1].displayName}. Which one is it?`;
        assistant.ask(ask);
      } else {
        assistant.setContext(TRY_AGAIN);
        assistant.ask(`Found ${matches.length} users for ${name}. Try to be more specific. Would you like to try again?`);
      }
    }


    /**************************************************/
    /* Send Message                                   */
    /**************************************************/
    function sendMessageSpecifyIntent(assistant) {
      log.info(`[${SEND_MESSAGE_SPECIFY_INTENT}]`);
      let users = assistant.data.usermatches;
      let query = assistant.getRawInput()
      let matches = circuit.searchByDisplayName(query, users);
      if (matches.length === 1) {
        let user = circuit.users[matches[0]];
        assistant.data.userId = user.userId;
        assistant.setContext(USER_CONFIRM_CONTEXT, 1, {user: user.displayName});
        assistant.ask(`${user.displayName}. Is this correct?`);
      } else {
        assistant.ask(`I didn't get that. Try again.`);
      }
    }

    function sendMessageConfirmTextIntent (assistant) {
      let text = assistant.getArgument(TEXT_ARGUMENT);
      log.info(`[${SEND_MESSAGE_CONFIRM_TEXT_INTENT}] text: ${text}`);
      let user = circuit.users[assistant.data.userId];
      assistant.ask(`Ready to send ${text} to ${user.displayName}`);
    }

    function sendMessageSendIntent (assistant) {
      log.info(`[${SEND_MESSAGE_SEND_INTENT}]`);

      let userId = assistant.data.userId;
      let user = circuit.users[userId];

      circuit.sendMessage(userId, assistant.data.text)
      .then(_ => {
        log.info(`[${SEND_MESSAGE_SEND_INTENT}] Message successfully from ${circuit.user.displayName} to ${user.displayName}`);
        assistant.setContext(SEND_MESSAGE_CONTEXT, 0);
        assistant.ask(`Message sent`);
      });
    }


    /**************************************************/
    /* Call User                                      */
    /**************************************************/
    function callUserSepcify(assistant) {
      log.info(`[${CALL_USER_SPECIFY_INTENT}]`);
      let users = assistant.data.usermatches;
      let query = assistant.getRawInput()
      let matches = circuit.searchByDisplayName(query, users);
      if (matches.length === 1) {
        let user = circuit.users[matches[0]];
        assistant.data.userId = user.userId;
        assistant.setContext(USER_CONFIRM_CONTEXT, 1, {user: user.displayName});
        assistant.ask(`Ok. Would you like to start the call?`);
      } else {
        assistant.ask(`I didn't get that. Try again.`);
      }
    }

    function callUserInitiateIntent (assistant) {
      let userId = assistant.data.userId;
      log.info(`[${CALL_USER_INITIATE_INTENT}] userId: ${userId}`);

      let user = circuit.users[userId];
      circuit.sendClickToCallRequest(user.emailAddress, null, null, true)
      .then(_ => assistant.ask(`Ok, calling ${user.firstName}`))
      .catch(_ => {
        if (user.phoneNumbers && user.phoneNumbers.length) {
          assistant.ask(`Logon to Circuit first, or you can call ${user.firstName} yourself. The number is ${user.phoneNumbers[0].phoneNumber}.`);
        } else {
          assistant.ask(`Logon to Circuit first and then try again.`);
        }
      });
    }

    /**************************************************/
    /* Join conference                                */
    /**************************************************/
    function meetingsListIntent (assistant) {
      log.info(`[${MEETINGS_LIST_INTENT}]`);

      circuit.getStartedCalls()
      .then(calls => {
        log.info(`Remote calls ${calls.length}`);
        if (calls.length === 0) {
          assistant.tell('You have currently no ongoing meetings.');
        } else if (calls.length === 1) {
          circuit.getConversationById(calls[0].convId)
          .then(conv => {
            assistant.data.callId = conv.rtcSessionId;
            assistant.setContext(USER_CONFIRM_CONTEXT);
            assistant.ask(`You have one meeting ongoing and its on conversation ${conv.topic}. Would you like to join?`);
          })
        } else {
          let reply = `You have ${calls.length} meetings ongoing.`;
          let convTopics = [];
          calls.forEach((call, index) => {
            circuit.getConversationById(call.convId)
            .then(conv => {
              convTopics.push(conv.topic);
              if (index === 0) {
                reply += ` The first meeting is on conversation ${conv.topic}.`;
              } else {
                reply += `The next meeting is on conversation ${conv.topic}.`;
              }
              if (index === (calls.length - 1)) {
                reply += 'Would you like to join any of those meetings?';
                assistant.ask(reply);
              }
            });
          });
        }
      })
      .catch(err => {
        log.error(err);
        assistant.tell('I cannot look up the meetings at this time. Try again later. The reason is ' + err.message);
      });
    }

    function meetingJoinIntent (assistant) {
      let callId = assistant.data.callId;
      log.info(`[${MEETING_JOIN_INTENT}] convId: ${callId}`);

      circuit.getDevices()
      .then(devices => {
        let device = devices.find(d => {
          return d.clientId !== circuit.user.clientId;
        });
        return device.clientId;
      })
      .then(circuit.joinConference.bind(null, callId, null))
      .then(_ => assistant.tell(`Ok, joining the conference`))
      .catch(_ => {
          assistant.tell(`Make sure you are logged on with a Circuit client.`);
      });
    }

    // Action map
    let actionMap = new Map();

    actionMap.set(WELCOME_INTENT, sendWelcomeIntent);
    actionMap.set(FIND_USER_INTENT, findUserIntent);

    actionMap.set(SEND_MESSAGE_CONFIRM_TEXT_INTENT, sendMessageConfirmTextIntent);
    actionMap.set(SEND_MESSAGE_SEND_INTENT, sendMessageSendIntent);
    actionMap.set(SEND_MESSAGE_SPECIFY_INTENT, sendMessageSpecifyIntent);

    actionMap.set(CALL_USER_INITIATE_INTENT, callUserInitiateIntent);
    actionMap.set(CALL_USER_SPECIFY_INTENT, callUserSepcify);

    actionMap.set(MEETINGS_LIST_INTENT, meetingsListIntent);
    actionMap.set(MEETING_JOIN_INTENT, meetingJoinIntent);

    assistant.handleRequest(actionMap);
  });
}

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
function destroy() {;
  let promises = [];
  Object.keys(sessions).forEach(key => promises.push(clearSession(key)));
  sessions = [];
  return Promise.all(promises);
}

module.exports = {
  init,
  destroy
}
