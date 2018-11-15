'use strict';

const CLIENT_ID = 'd34edad8cda6433bb062f0671f58c232';
const CircuitClient = require('./circuitClient');


const { dialogflow, Image, BasicCard, Suggestions, Button } = require('actions-on-google');
const app = dialogflow({clientId: CLIENT_ID});

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5min session timeout

const sessions = {}; // Active sessions


function init(express) {
  console.log(`Initialize va`);

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

  /**
   * message.send
   */
  app.intent('send.message', async (conv, {target, message}) => {
    const circuit = await getCircuit(conv);
    if (!circuit) {
      return;
    }

    target = target || conv.contexts.input['sendmessage_data'].parameters.target;
    message = message || conv.contexts.input['sendmessage_data'].parameters.message;

    let users = await circuit.searchUsers(target);
    let convs = await circuit.searchConversationsByName(target);

    if (!users.length && !convs.length) {
      conv.ask(`I cannot find any user or conversation called ${target}. What's the name?`);
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
    const circuit = await getCircuit(conv);
    if (!circuit) {
      return;
    }

    let users = await circuit.searchUsers(conv.parameters.target);
    let convs = await circuit.searchConversationsByName(conv.parameters.target);
    if (!users.length && !convs.length) {
      conv.ask(`I cannot find any user or conversation called ${target}. What's the name?`);
      return;
    }

    const { convId } = users.length && await circuit.getDirectConversationWithUser(users[0].userId, true);
    const { message } = conv.contexts.input['sendmessage_data'].parameters;
    const name = users.length && users[0].displayName || convs[0].topic;
    conv.ask(`<speak>Ready to send <break time="0.5s"/>${message}<break time="0.5s"/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
    conv.contexts.set('sendmessage_send', 5, {
      convId: convId || convs[0].convId
    });
  });

  app.intent('send.message - yes', async conv => {
    const circuit = await getCircuit(conv);
    if (!circuit) {
      return;
    }
    const { message } = conv.contexts.input['sendmessage_data'].parameters;
    const { convId } = conv.contexts.input['sendmessage_send'].parameters;
    await circuit.addTextItem(convId, message);
    conv.contexts.delete('sendmessage_data');
    conv.ask('Message sent. Is there anything else I can do for you?');
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2);
  });

  app.intent('send.message - no', async conv => {
    conv.contexts.delete('sendmessage_data');
    conv.ask('Message not sent. Is there anything else I can do for you?');
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2);
  });

  /**
  * call.user
  */
  app.intent('call.user', async (conv, {target}) => {
    const circuit = await getCircuit(conv);
    if (!circuit) {
      return;
    }

    let users = await circuit.searchUsers(target);

    if (!users.length) {
      conv.contexts.set('calluser_getuser', 5);
      conv.ask(`I cannot find any user called ${target}. What's the name?`);
      return;
    }

    if (users.length === 1) {
      // One result found. Ask user for confirmation.
      const name = users.length && users[0].displayName;
      conv.ask(`<speak>Ready to call ${name}?</speak>`, new Suggestions('Yes', `No`));
      conv.contexts.set('calluser_data', 5, {
        email: users[0].emailAddress,
        name: name
      });
      return;
    }

    // Multiple matches. Show suggestions of the first few matches.
    users = users.slice(0, Math.min(7, users.length));

    const suggestions = users.map(u => u.displayName);
    conv.contexts.set('calluser_getuser', 5);

    conv.ask(`More than one user found with name ${target}. What's the the full name?`, new Suggestions(suggestions));
    conv.ask(new Suggestions(suggestions));
  });

  app.intent('call.user - collect target', async (conv, {target}) => {
    const circuit = await getCircuit(conv);
    if (!circuit) {
      return;
    }

    let users = await circuit.searchUsers(target);

    if (!users.length) {
      conv.ask(`I cannot find any user called ${target}.`);
      return;
    }

    if (users.length === 1) {
      // One result found. Ask user for confirmation.
      const name = users.length && users[0].displayName;
      conv.ask(`<speak>Ready to call ${name}?</speak>`, new Suggestions('Yes', `No`));
      conv.contexts.set('calluser_data', 5, {
        email: users[0].emailAddress,
        name: name
      });
      return;
    }

    // Multiple matches. Show suggestions of the first few matches.
    users = users.slice(0, Math.min(7, users.length));

    const suggestions = users.map(u => u.displayName);
    conv.contexts.set('calluser_getuser', 5);

    conv.ask(`More than one user or conversation found with name ${target}. What's the full name?`, new Suggestions(suggestions));
    conv.ask(new Suggestions(suggestions));
  });

  app.intent('call.user - yes', async conv => {
    const circuit = await getCircuit(conv);
    if (!circuit) {
      return;
    }
    const device = await findWebClient(circuit);
    const { email, name } = conv.contexts.input['calluser_data'].parameters;
    try {
      await circuit.sendClickToCallRequest(email, null, device && device.clientId, false);
      conv.ask(`Ok, calling ${name} on your browser.`);
    } catch (err) {
      conv.ask(`Looks like you are not logged in to Circuit on your browser. Login and try again.`);
    }
    conv.contexts.delete('calluser_data');
    conv.close();
  });

  app.intent('call.user - no', async conv => {
    conv.contexts.delete('calluser_data');
    conv.ask('Is there anything else I can do for you?');
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2);
  });

  /**
   * Common intents
   */

  app.intent('anything.else - yes', async conv => {
    conv.followup('Welcome');
  });

  app.intent('anything.else - no', async conv => {
    conv.ask('Good Bye');
    conv.close();
  });

  /**
   * Get the circuit instance from the session. Create a new session if needed
   */
  async function getCircuit(conv) {
    try {
      const session = sessions[conv.user.id] || (await createSession(conv.user));
      return session.circuit;
    } catch (err) {
      conv.ask('No circuit session found. Start over please.');
      conv.close();
    }
  }
}


function createSession(user) {
  const circuit = new CircuitClient({client_id: CLIENT_ID});
  return circuit.logon(user.access.token)
    .then(() => {
      const session = {
        circuit: circuit,
        timer: setTimeout(clearSession.bind(null, user.id), SESSION_TIMEOUT)
      }
      sessions[user.id] = session;
      return session;
    })
    .catch(err => console.error(`Unable to logon to Circuit`, err));
}

function findWebClient(circuit) {
  return circuit.getDevices().then(devices => {
      return devices.find(device => {
          return (device.clientId !== circuit.user.clientId) &&
              ((device.clientInfo.deviceType === 'WEB') ||
              (device.clientInfo.deviceType === 'APPLICATION' && device.clientInfo.deviceSubtype === 'DESKTOP_APP'));
      });
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
  console.log(`Clearing session ${sessionId}`);
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
