const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder: S, PermissionFlagsBits: P, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder,
} = require('discord.js');
const { EPH, COLORS, embed, modLog } = require('../util');
const { guild: gs, save } = require('../db');

const LOGO_FILE = path.join(__dirname, '..', '..', 'logo.jpg'); // logo.jpg in the repo root
const RECOVER_URL = process.env.HONEYPOT_RECOVER_URL || 'https://support.discord.com';
const inFlight = new Set(); // users currently being processed (stops double kicks from rapid spam)

// Logo for the panel + DM: HONEYPOT_LOGO_URL env var, else logo.jpg from the repo, else none.
function logo() {
  if (process.env.HONEYPOT_LOGO_URL) return { url: process.env.HONEYPOT_LOGO_URL, files: [] };
  if (fs.existsSync(LOGO_FILE)) return { url: 'attachment://logo.jpg', files: [new AttachmentBuilder(LOGO_FILE, { name: 'logo.jpg' })] };
  return { url: null, files: [] };
}

const countRow = (h) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('hp:count').setEmoji('🍯')
    .setLabel(`${h.mode === 'softban' ? 'Softbans' : 'Kicks'}: ${h.count}`)
    .setStyle(ButtonStyle.Secondary).setDisabled(true));

const commands = [
  {
    data: new S().setName('honeypot').setDescription('Turn a channel into a honeypot that kicks anyone who types in it')
      .setDefaultMemberPermissions(P.Administrator)
      .addChannelOption((o) => o.setName('channel').setDescription('The honeypot channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption((o) => o.setName('mode').setDescription('What happens to them (default: kick)')
        .addChoices({ name: 'kick', value: 'kick' }, { name: 'softban (kick + delete their last day of messages)', value: 'softban' })),
    async execute(i) {
      const ch = i.options.getChannel('channel');
      const mode = i.options.getString('mode') || 'kick';
      const me = i.guild.members.me;
      if (!me.permissions.has(P.KickMembers) || (mode === 'softban' && !me.permissions.has(P.BanMembers)))
        return i.reply({ content: `❌ I need the ${mode === 'softban' ? 'Ban Members' : 'Kick Members'} permission.`, flags: EPH });

      const s = gs(i.guild.id);
      const h = (s.honeypot = { channelId: ch.id, mode, count: s.honeypot?.count ?? 0 });
      const l = logo();
      const e = new EmbedBuilder().setColor(0x2b2d31)
        .setTitle('DO NOT SEND MESSAGES IN THIS CHANNEL')
        .setDescription(`This channel is used to catch spam bots. Any messages sent here will result in a ${mode === 'softban' ? 'softban' : 'kick'}.`);
      if (l.url) e.setThumbnail(l.url);
      const msg = await ch.send({ embeds: [e], components: [countRow(h)], files: l.files });
      h.messageId = msg.id;
      save();
      await i.reply({ content: `✅ Honeypot is live in ${ch}. Anyone who isn't staff and types there gets the DM, then a ${mode}.\nKeep that channel visible to everyone so bots stumble into it. Test it with an alt account (the owner and staff are exempt).`, flags: EPH });
    },
  },
  {
    data: new S().setName('honeypotoff').setDescription('Turn the honeypot off').setDefaultMemberPermissions(P.Administrator),
    async execute(i) {
      const s = gs(i.guild.id);
      if (!s.honeypot) return i.reply({ content: 'No honeypot is set up.', flags: EPH });
      delete s.honeypot; save();
      await i.reply({ content: '✅ Honeypot turned off. You can delete the channel or its message.', flags: EPH });
    },
  },
];

// Called for every message. Returns true if the message was in the honeypot channel.
async function onMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId) return false;
  const h = gs(message.guild.id).honeypot;
  if (!h || message.channelId !== h.channelId) return false;

  const guild = message.guild;
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return true;

  // Never touch the owner or staff.
  const staff = member.id === guild.ownerId ||
    member.permissions.any([P.Administrator, P.ManageGuild, P.ManageMessages, P.KickMembers, P.BanMembers, P.ModerateMembers]);
  if (staff) return true;
  if (inFlight.has(member.id)) { await message.delete().catch(() => {}); return true; }
  inFlight.add(member.id);

  try {
    const content = message.content || '(no text)';
    await message.delete().catch(() => {});

    if (!member.kickable) {
      await modLog(guild, embed(COLORS.warn, '🍯 Honeypot triggered (not actioned)',
        `${member.user.tag} (${member.id}) wrote in ${message.channel}, but my role is too low to ${h.mode} them.`));
      return true;
    }

    // 1) DM first (once they're kicked, we can no longer reach them)
    const l = logo();
    const dm = new EmbedBuilder().setColor(0xfdd34d).setTitle('Honeypot Triggered').setDescription([
      `Hey ${member}, you have been **kicked** from **${guild.name}** for sending a message in the ${message.channel} channel.`,
      '',
      `This may have happened if someone gained access to your account through malware, stolen sessions or leaked passwords. Please [recover your account](${RECOVER_URL}), scan your device and reinstall your OS if needed.`,
      '',
      `-# Automated message sent on behalf of **${guild.name}**. Replies are not monitored.`,
    ].join('\n'));
    if (l.url) dm.setThumbnail(l.url);
    await member.send({ embeds: [dm], files: l.files }).catch(() => {});

    // 2) Then kick (or softban)
    const reason = 'Honeypot triggered';
    if (h.mode === 'softban') {
      await guild.members.ban(member.id, { reason, deleteMessageSeconds: 86400 });
      await guild.members.unban(member.id, 'Honeypot softban');
    } else {
      await member.kick(reason);
    }

    // 3) Update the counter on the panel + log it
    h.count += 1; save();
    const panel = await message.channel.messages.fetch(h.messageId).catch(() => null);
    if (panel) await panel.edit({ components: [countRow(h)] }).catch(() => {});
    await modLog(guild, embed(COLORS.bad, '🍯 Honeypot triggered',
      `**${member.user.tag}** (${member.id}) was ${h.mode === 'softban' ? 'softbanned' : 'kicked'}.\n**Message:** ${content.slice(0, 300)}`));
  } catch (e) {
    console.error('Honeypot error:', e);
  } finally {
    inFlight.delete(member.id);
  }
  return true;
}

module.exports = { commands, onMessage };
