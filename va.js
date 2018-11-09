'use strict';

const CLIENT_ID = 'd34edad8cda6433bb062f0671f58c232';
const util = require('util');
const log = require('./logger').child({module: 'va'});
const CircuitClient = require('./circuitClient');


const { dialogflow, Image, BasicCard, Suggestions, Button } = require('actions-on-google');
const app = dialogflow({clientId: CLIENT_ID});

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5min session timeout

const sessions = {}; // Active sessions


function init(express) {
  log.info(`Initialize va`);

  express.use(app);

  app.intent('Default Welcome Intent', conv => {
    // Create a session for this user at the beginning so user
    // is logged on to Circuit by the time needed
    if (!sessions[conv.user.id]) {
      createSession(conv.user);
    }

    conv.ask(`What can I do for you?`);
    conv.ask(new Suggestions('Send a message', 'Make a call'));
  });

  app.intent('send.message', async (conv, {target, message}) => {
    if (!sessions[conv.user.id]) {
      conv.ask('There has been an error. Start over please.');
      conv.close();
      return;
    }

    target = target || conv.contexts.input['sendmessage_data'].parameters.target;
    message = message || conv.contexts.input['sendmessage_data'].parameters.message;


    const circuit = sessions[conv.user.id].circuit;
    let users = await circuit.searchUsers(target);
    let convs = await circuit.searchConversationsByName(target);

    if (!users.length && !convs.length) {
      conv.ask(`I cannot find any user or conversation called ${target}.`);
      return;
    }

    if (users.length + convs.length === 1) {
      // One result found. Ask user for confirmation.
      const { convId } = users.length && await circuit.getDirectConversationWithUser(users[0].userId, true);
      const name = users.length && users[0].displayName || convs[0].topic;
      conv.ask(`<speak>Ready to send <break time="0.5s"/>${message}<break time="0.5s"/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
      conv.contexts.set('sendmessage_send', 5, {
        convId: convId || convs[0].convId
      });
      return;
    }

    // Multiple matches. Show suggestions of the first few matches.
    users = users.slice(0, Math.min(7, users.length));
    //convs = convs.slice(0, Math.min(7, convs.length));

    const suggestions = users.map(u => u.displayName);
    conv.contexts.set('sendmessage_getconv', 5);

    conv.ask(`More than one user found with name ${target}. What's the the full name?`, new Suggestions(suggestions));
    conv.ask(new Suggestions(suggestions));
  });

  app.intent('send.message - collect.target', async conv => {
    const circuit = sessions[conv.user.id].circuit;
    let users = await circuit.searchUsers(conv.parameters.target);
    const { convId } = users.length && await circuit.getDirectConversationWithUser(users[0].userId, true);
    const { message } = conv.contexts.input['sendmessage_data'].parameters;
    const name = users.length && users[0].displayName || convs[0].topic;
    conv.ask(`<speak>Ready to send <break time="0.5s"/>${message}<break time="0.5s"/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
    conv.contexts.set('sendmessage_send', 5, {
      convId: convId || convs[0].convId
    });
  });

  app.intent('send.message - yes', async conv => {
    const circuit = sessions[conv.user.id].circuit;
    const { message } = conv.contexts.input['sendmessage_data'].parameters;
    const { convId } = conv.contexts.input['sendmessage_send'].parameters;
    await circuit.addTextItem(convId, message);
    conv.close(`Message sent`);
    conv.contexts.delete('sendmessage_data');
  });

}


function createSession(user) {
  const circuit = new CircuitClient({client_id: CLIENT_ID});
  circuit.logon(user.access.token)
    .then(() => {
      sessions[user.id] = {
        circuit: circuit,
        timer: setTimeout(clearSession.bind(null, user.id), SESSION_TIMEOUT)
      }
    })
    .catch(err => log.error(`Unable to logon to Circuit`, err));
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
