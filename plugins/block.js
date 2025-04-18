// when stealing remember to credit Frank dev

import config from '../config.cjs';

const block = async (m, gss) => {
  try {
    const botNumber = await gss.decodeJid(gss.user.id);
    const isCreator = [botNumber, ...config.OWNER_NUMBER.split(',').map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net')].includes(m.sender);
    const prefix = config.PREFIX;
    
    if (!m.body.toLowerCase().startsWith(prefix + 'block')) return;
    
    if (!isCreator) return m.reply("*❌only the owner can use the command*");
    
    const args = m.body.slice(prefix.length + 'block'.length).trim();
    
    let users;
    if (m.mentionedJid && m.mentionedJid[0]) {
      users = m.mentionedJid[0];
    } else if (m.quoted) {
      users = m.quoted.sender;
    } else if (args) {
      const number = args.replace(/[^0-9]/g, '');
      if (number.length < 10) {
        return m.reply("❌ *Please provide a valid phone number, mention a user, or quote a message.*");
      }
      users = number + '@s.whatsapp.net';
    } else {
      return m.reply("❌ *Please provide a phone number, mention a user, or quote a message to block.*");
    }
    
    const ownerNumbers = config.OWNER_NUMBER.split(',').map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    
    if (users === botNumber || ownerNumbers.includes(users)) {
      return m.reply("❌ *Cannot block the bot itself or the owner.*");
    }
    
    await gss.sendMessage(m.from, { react: { text: "🔄", key: m.key } });
    
    try {
      await gss.updateBlockStatus(users, 'block');
      
      await gss.sendMessage(m.from, { react: { text: "✅", key: m.key } });
      
      const messageOptions = {
        contextInfo: {
          mentionedJid: [users],
          forwardingScore: 999,
          isForwarded: true,
          forwardedNewsletterMessageInfo: {
            newsletterJid: '120363419090892208@newsletter',
            newsletterName: "EF-PRIME MANAGEMENT",
            serverMessageId: 144,
          },
        },
      };
      
      gss.sendMessage(m.from, { 
        text: `✅ *User ${users.split('@')[0]} has been blocked successfully.*`,
        ...messageOptions
      }, { quoted: m });
    } catch (err) {
      await gss.sendMessage(m.from, { react: { text: "❌", key: m.key } });
      m.reply(`❌ *Failed to block user: ${err}*`);
    }
  } catch (error) {
    console.error('Error:', error);
    m.reply('❌ *An error occurred while processing the command.*');
  }
};

export default block;