'use strict';
const { dialogflow, Suggestions } = require('actions-on-google');
const express = require('express');
const bodyParser = require('body-parser');
const CircuitClient = require('./circuitClient');

// Client ID for IMPLICIT app on Circuit. Same ID needs to be defined
// in Account Linking of your project at console.actions.google.com
const CLIENT_ID = '<your client_id>';

// Circuit session timeout
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5min session timeout

const sessions = {}; // Active sessions

const app = dialogflow({ clientId: CLIENT_ID });

// Create express app to for handling the /_ah/start request posted
// by AppEngine
const expressApp = express();
expressApp.get('/_ah/start', (req, res) => {
  console.log('handle _ah/start');
  res.sendStatus(200);
});

// Add dialogFlow as middleware
expressApp.use(bodyParser.json(), app);

// Start server
expressApp.listen(process.env.PORT || 8080, () => console.log('Listening at port 8080'));

/**
 * Default Welcome Intent
 */
app.intent('Default Welcome Intent', conv => {
  // Create a session for this user at the beginning so user
  // is logged on to Circuit by the time needed
  if (!sessions[conv.user.storage]) {
    createSession(conv.user);
  }

  conv.ask(`What can I do for you?`);
  conv.ask(new Suggestions('Send a message', 'Make a call'));
});

/**
 * add.participant.to.group
 */
app.intent('add.participant.to.group', async (conv, { convName, user }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await circuit.searchUsers(user);
  let convs = await circuit.searchConversationsByName(convName);

  //Save results to context
  conv.contexts.set('addparticipantgroup_data', 5, {
    users: users,
    convs: convs
  });

  if (!users.length) {
    //No user found
    conv.ask(`I cannot find any user called ${user}. What's the name?`);
    conv.contexts.set('addparticipantgroup_getuser', 5);
    return;
  } else if (users.length > 1) {
    // Multiple users found
    users = users.slice(0, Math.min(7, users.length));
    const suggestions = users.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${user}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantgroup_getuser', 5);
    return;
  }

  if (!convs.length) {
    //No conversation found
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);

    conv.ask(`More than one conversation was found with the name ${convName}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  }

  //One result found for user and conversation
  conv.ask(`Ready to add ${users[0].displayName} to ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.group - collect.conv
 */
app.intent('add.participant.to.group - collect.conv', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users } = conv.contexts.input['addparticipantgroup_data'].parameters;
  let convName = conv.parameters.convName;
  let convs = await circuit.searchConversationsByName(convName);

  if (!convs.length) {
    //No conversation found
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    return;
  } else if (convs.length > 1) {
    //Multiple conversations found
    let shortestConvName = [convs[0]];

    //Loop through convs to find shortest conv name
    convs.forEach(function(conv, i) {
      if (conv.topic < shortestConvName[0].topic) {
        shortestConvName[0] = conv;
      }
    });

    convs = shortestConvName;
  }

  //Save conversation to context because only one found
  conv.contexts.set('addparticipantgroup_data', 5, { convs: convs });
  conv.contexts.delete('addparticipantgroup_getconv');

  //Users.length is always equal to one at this point
  conv.ask(`Ready to add ${users[0].displayName} to ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.group - collect.user
 */
app.intent('add.participant.to.group - collect.user', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let { convs } = conv.contexts.input['addparticipantgroup_data'].parameters;
  let user = conv.parameters.user;
  let users = await circuit.searchUsers(user);

  if (!users.length) {
    //No user found
    conv.ask(`I cannot find any user called ${user}. What's the name?`);
    return;
  } else if (users.length > 1) {
    // Multiple users found
    users = users.slice(0, Math.min(7, users.length));
    const suggestions = users.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${user}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantgroup_getuser', 5);
    return;
  }

  //Save user to context because only one found
  conv.contexts.set('addparticipantgroup_data', 5, { users: users });
  conv.contexts.delete('addparticipantgroup_getuser');

  if (!convs.length) {
    //No conversation found
    conv.ask(`Thank you. I did not find the conversation name that you gave me earlier. What is it again?`);
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);

    conv.ask(`Thank you. I found more than one result for the conversation name you gave me earlier. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  }

  //One result found for user and conversation
  conv.ask(`Ready to add ${user} to ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.group - no
 */
app.intent('add.participant.to.group - no', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  conv.ask('Is there anything else I can do for you?', new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantgroup_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * add.participant.to.group - yes
 */
app.intent('add.participant.to.group - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users, convs } = conv.contexts.input['addparticipantgroup_data'].parameters;
  const thisUser = circuit.user;

  if (convs[0].participants.indexOf(users[0].userId) !== -1) {
    //User is already in the conversation
    conv.ask(`${users[0].displayName} is already a participant in ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantgroup_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  if (convs[0].isModerated && convs[0].moderators.indexOf(thisUser.userId) === -1) {
    //Conversation is moderated and thisUser is not a moderator
    conv.ask(`Sorry, but you are not a moderator in ${convs[0].topic} so ${users[0].displayName} cannot be added. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantgroup_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  await circuit.addParticipant(convs[0].convId, users[0].userId, true);
  conv.ask(`${users[0].displayName} was added to ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantgroup_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * add.participant.to.one
 */
app.intent('add.participant.to.one', async (conv, { thirdUser, target }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let thirdUsers = await circuit.searchUsers(thirdUser);
  let targetUsers = await circuit.searchUsers(target);

  //Save results to context
  conv.contexts.set('addparticipantone_data', 5, {
    thirdUsers: thirdUsers,
    targetUsers: targetUsers
  });

  if (!thirdUsers.length) {
    //No user found
    conv.ask(`I cannot find any user called ${thirdUser}. What's the name?`);
    conv.contexts.set('addparticipantone_getuser', 5);
    return;
  } else if (thirdUsers.length > 1) {
    // Multiple users found
    thirdUsers = thirdUsers.slice(0, Math.min(7, thirdUsers.length));
    const suggestions = thirdUsers.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${thirdUser}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantone_getuser', 5);
    return;
  }

  if (!targetUsers.length) {
    //No user found
    conv.ask(`I cannot find any user called ${thirdUser}. What's the name?`);
    conv.contexts.set('addparticipantone_getuser', 5);
    return;
  } else if (targetUsers.length > 1) {
    // Multiple users found
    targetUsers = targetUsers.slice(0, Math.min(7, targetUsers.length));
    const suggestions = targetUsers.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${target}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantone_getuser', 5);
    return;
  }

  //One result found for thirdUser and target
  conv.ask(`Ready to add ${thirdUsers[0].displayName} to your conversation with ${targetUsers[0].displayName}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.one - collect.user
 */
app.intent('add.participant.to.one - collect.user', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let { thirdUsers, targetUsers } = conv.contexts.input['addparticipantone_data'].parameters;
  let user = conv.parameters.user;
  let users = await circuit.searchUsers(user);

  if (!users.length) {
    //No user found
    conv.ask(`I cannot find any user called ${user}. What's the name?`);
    return;
  } else if (users.length > 1) {
    // Multiple users found
    users = users.slice(0, Math.min(7, users.length));
    const suggestions = users.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${user}. What's the full name?`, new Suggestions(suggestions));
    return;
  }

  //One user found beyond this point
  let params = conv.contexts.output['addparticipantone_data'].parameters;

  if (thirdUsers.length !== 1 && !targetUsers.length) {
    params = conv.contexts.output['addparticipantone_data'].parameters;

    //Add thirdUser to context
    params.thirdUsers = [users[0]];
    conv.contexts.set('addparticipantone_data', 5, params);

    conv.ask(`Thank you. I couldn't find the user whose conversation you wanted me to add ${users[0].displayName} to. What's the name again?`);
    return;
  }

  if (thirdUsers.length !== 1 && targetUsers.length > 1) {
    params = conv.contexts.input['addparticipantone_data'].parameters;

    //Add thirdUser to context
    params.thirdUsers = [users[0]];
    conv.contexts.set('addparticipantone_data', 5, params);

    let tempUsers = targetUsers.slice(0, Math.min(7, targetUsers.length));
    const suggestions = tempUsers.map(u => u.displayName);

    conv.ask(`Thank you. I found more than one user whose conversation you wanted me to add ${users[0].displayName} to. What's the full name?`, new Suggestions(suggestions));
    return;
  }

  if (targetUsers.length !== 1) {
    params = conv.contexts.input['addparticipantone_data'].parameters;

    //Add targetUser to context
    params.targetUsers = [users[0]];
    conv.contexts.set('addparticipantone_data', 5, params);
  }

  conv.ask(`Ready to add ${thirdUsers[0].displayName} to your conversation with ${users[0].displayName}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.one - no
 */
app.intent('add.participant.to.one - no', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  conv.ask('Is there anything else I can do for you?', new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantone_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * add.participant.to.one - yes
 */
app.intent('add.participant.to.one - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { thirdUsers, targetUsers } = conv.contexts.input['addparticipantone_data'].parameters;
  const conversation = await circuit.getDirectConversationWithUser(targetUsers[0].userId);

  if (!conversation) {
    //No direct conversation found
    conv.ask(`You are not in a direct conversation with ${targetUsers[0].displayName}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantone_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  if (thirdUsers[0].userId === targetUsers[0].userId) {
    //thirdUser and targetUser is the same user
    conv.ask(`I cannot add ${thirdUsers[0].displayName} to his own conversation. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantone_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  await circuit.addParticipant(conversation.convId, thirdUsers[0].userId);

  conv.ask(`${thirdUsers[0].displayName} has been added to your conversation with ${targetUsers[0].displayName}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantone_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * remove.participant
 */
app.intent('remove.participant', async (conv, { user, convName }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await circuit.searchUsers(user);
  let convs = await circuit.searchConversationsByName(convName);

  //Save results to context
  conv.contexts.set('removeparticipant_data', 5, {
    users: users,
    convs: convs
  });

  if (!users.length) {
    //No user found
    conv.ask(`I cannot find any user called ${user}. What's the name?`);
    conv.contexts.set('removeparticipant_getuser', 5);
    return;
  } else if (users.length > 1) {
    // Multiple users found
    users = users.slice(0, Math.min(7, users.length));
    const suggestions = users.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${user}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('removeparticipant_getuser', 5);
    return;
  }

  if (!convs.length) {
    //No conversation found
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);

    conv.ask(`More than one conversation was found with the name ${convName}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  }

  //One result found for user and conversation
  conv.ask(`Ready to remove ${users[0].displayName} from ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * remove.participant - collect.conv
 */
app.intent('remove.participant - collect.conv', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users } = conv.contexts.input['removeparticipant_data'].parameters;
  let convName = conv.parameters.convName;
  let convs = await circuit.searchConversationsByName(convName);

  if (!convs.length) {
    //No conversation found
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    return;
  } else if (convs.length > 1) {
    //Multiple conversations found
    let shortestConvName = [convs[0]];

    //Loop through convs to find shortest conv name
    convs.forEach(function(conv, i) {
      if (conv.topic < shortestConvName[0].topic) {
        shortestConvName[0] = conv;
      }
    });

    convs = shortestConvName;
  }

  //Save conversation to context because only one found
  conv.contexts.set('removeparticipant_data', 5, { convs: convs });
  conv.contexts.delete('removeparticipant_getconv');

  //Users.length is always equal to one at this point
  conv.ask(`Ready to remove ${users[0].displayName} from ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * remove.participant - collect.user
 */
app.intent('remove.participant - collect.user', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let { convs } = conv.contexts.input['removeparticipant_data'].parameters;
  let user = conv.parameters.user;
  let users = await circuit.searchUsers(user);

  if (!users.length) {
    //No user found
    conv.ask(`I cannot find any user called ${user}. What's the name?`);
    return;
  } else if (users.length > 1) {
    // Multiple users found
    users = users.slice(0, Math.min(7, users.length));
    const suggestions = users.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${user}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('removeparticipant_getuser', 5);
    return;
  }

  //Save user to context because only one found
  conv.contexts.set('removeparticipant_data', 5, { users: users });
  conv.contexts.delete('removeparticipant_getuser');

  if (!convs.length) {
    //No conversation found
    conv.ask(`Thank you. I did not find the conversation name that you gave me earlier. What is it again?`);
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);

    conv.ask(`Thank you. I found more than one result for the conversation name you gave me earlier. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  }

  //One result found for user and conversation
  conv.ask(`Ready to remove ${user} from ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * remove.participant - no
 */
app.intent('remove.participant - no', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  conv.ask('Is there anything else I can do for you?', new Suggestions('Yes', 'No'));
  conv.contexts.delete('removeparticipant_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * remove.participant - yes
 */
app.intent('remove.participant - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users, convs } = conv.contexts.input['removeparticipant_data'].parameters;
  const thisUser = circuit.user;

  if (convs[0].participants.indexOf(users[0].userId) === -1) {
    //User is already in the conversation
    conv.ask(`${users[0].displayName} is not a participant in ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('removeparticipant_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  if (convs[0].isModerated && convs[0].moderators.indexOf(thisUser.userId) === -1) {
    //Conversation is moderated and thisUser is not a moderator
    conv.ask(`Sorry, but you are not a moderator in ${convs[0].topic} so ${users[0].displayName} cannot be removed. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('removeparticipant_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  await circuit.removeParticipant(convs[0].convId, users[0].userId, true);
  conv.ask(`${users[0].displayName} was removed from ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
  conv.contexts.delete('removeparticipant_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * send.message
 */
app.intent('send.message', async (conv, { target, message }) => {
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
    conv.contexts.set('sendmessage_getconv', 5);
    return;
  }

  if (users.length + convs.length === 1) {
    // One result found. Ask user for confirmation.
    const { convId } = users.length && (await circuit.getDirectConversationWithUser(users[0].userId, true));
    const name = (users.length && users[0].displayName) || convs[0].topic;
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

  conv.ask(`More than one user found with name ${target}. What's the full name?`, new Suggestions(suggestions));
});

/**
 * send.message - collect.target
 */
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

  const { convId } = users.length && (await circuit.getDirectConversationWithUser(users[0].userId, true));
  const { message } = conv.contexts.input['sendmessage_data'].parameters;
  const name = (users.length && users[0].displayName) || convs[0].topic;
  conv.ask(`<speak>Ready to send <break time="0.5s"/>${message}<break time="0.5s"/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
  conv.contexts.set('sendmessage_send', 5, {
    convId: convId || convs[0].convId
  });
});

/**
 * send.message - yes
 */
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
  conv.ask(new Suggestions("No, that's all", 'Yes'));
  conv.contexts.set('anything_else', 2);
});

/**
 * send.message - no
 */
app.intent('send.message - no', async conv => {
  conv.contexts.delete('sendmessage_data');
  conv.ask('Message not sent. Is there anything else I can do for you?');
  conv.ask(new Suggestions("No, that's all", 'Yes'));
  conv.contexts.set('anything_else', 2);
});

/**
 * call.user
 */
app.intent('call.user', async (conv, { target }) => {
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

  conv.ask(`More than one user found with name ${target}. What's the full name?`, new Suggestions(suggestions));
  conv.ask(new Suggestions(suggestions));
});

/**
 * call.user - collect target
 */
app.intent('call.user - collect target', async (conv, { target }) => {
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

/**
 * call.user - yes
 */
app.intent('call.user - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const device = await findWebClient(circuit);
  const { email, name } = conv.contexts.input['calluser_data'].parameters;
  try {
    await circuit.sendClickToCallRequest(email, null, device && device.clientId, true);
    conv.ask(`Ok, calling ${name} on your browser.`);
  } catch (err) {
    conv.ask(`Looks like you are not logged in to Circuit on your browser on the desktop. Login and try again.`);
  }
  conv.contexts.delete('calluser_data');
  conv.close();
});

app.intent('call.user - no', async conv => {
  conv.contexts.delete('calluser_data');
  conv.ask('Is there anything else I can do for you?');
  conv.ask(new Suggestions("No, that's all", 'Yes'));
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
 * Exception handler
 */
app.catch((conv, e) => {
  console.error(e);
  conv.close('Oops. Something went wrong.');
});

/**
 * Get the circuit instance from the session. Create a new session if needed
 */
async function getCircuit(conv) {
  try {
    const session = sessions[conv.user.storage] || (await createSession(conv.user));
    return session.circuit;
  } catch (err) {
    conv.ask('No circuit session found. Start over please.');
    conv.close();
  }
}

/**
 * Create Circuit session
 */
function createSession(user) {
  const circuit = new CircuitClient({ client_id: CLIENT_ID });
  return circuit
    .logon(user.access.token)
    .then(() => {
      const session = {
        circuit: circuit,
        timer: setTimeout(clearSession.bind(null, user.storage), SESSION_TIMEOUT)
      };
      sessions[user.storage] = session;
      return session;
    })
    .catch(err => console.error(`Unable to logon to Circuit`, err));
}

/**
 * Find web client of logged on user
 */
function findWebClient(circuit) {
  return circuit.getDevices().then(devices => {
    return devices.find(device => {
      return device.clientId !== circuit.user.clientId && (device.clientInfo.deviceType === 'WEB' || (device.clientInfo.deviceType === 'APPLICATION' && device.clientInfo.deviceSubtype === 'DESKTOP_APP'));
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
function destroy() {
  let promises = [];
  Object.keys(sessions).forEach(key => promises.push(clearSession(key)));
  sessions = [];
  return Promise.all(promises);
}
