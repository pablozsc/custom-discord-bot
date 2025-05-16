const { ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { exec } = require("child_process");
const { Pool } = require("pg");

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAIM_CHANNEL_ID = process.env.CLAIM_CHANNEL_ID;
const DELEGATOR_ROLE_ID = process.env.DELEGATOR_ROLE_ID;
const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const delegatorVerificationState = new Map();

async function handleDelegatorVerification(interaction, discordId, client) {
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);

        if (member.roles.cache.has(DELEGATOR_ROLE_ID)) {
            await interaction.reply({
                content: "✅ You already have the **Delegator** role — no need to verify again.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (delegatorVerificationState.has(discordId)) {
            const existing = delegatorVerificationState.get(discordId);
            const existingThread = await client.channels.fetch(existing.threadId).catch(() => null);

            if (existingThread) {
                await interaction.reply({
                    content: `⚠️ You already have an active verification thread.\n👉 [Open thread](https://discord.com/channels/${GUILD_ID}/${existingThread.id})`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            } else {
                delegatorVerificationState.delete(discordId);
            }
        }

        const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID);
        const thread = await verificationChannel.threads.create({
            name: `delegator-${interaction.user.username}`,
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 60,
            reason: `Delegator verification for ${interaction.user.tag}`
        });

        await thread.members.add(interaction.user.id);

        delegatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-account-address"
        });

        await interaction.reply({
            content: `📩 Verification started.\n👉 [Click here to open your thread](https://discord.com/channels/${GUILD_ID}/${thread.id})`,
            flags: MessageFlags.Ephemeral
        });

        await thread.send(`<@${interaction.user.id}> Please send your **account address** to begin verification.\nYou must delegate at least **1000 CCD**.\n\nIf you entered the wrong address, you can use the command \`/start-again-delegator\` to restart.`);
    } catch (err) {
        console.error("Delegator verification thread error:", err);
        await interaction.reply({
            content: "❌ Failed to start delegator verification. Please contact a moderator.",
            flags: MessageFlags.Ephemeral
        });
    }
}

function listenForDelegatorMessages(client) {
    client.on("messageCreate", async (message) => {
        if (!message.channel.isThread()) return;
        if (message.author.bot) return;

        const state = delegatorVerificationState.get(message.author.id);
        if (!state || state.threadId !== message.channel.id) return;

        if (state.step === "awaiting-account-address") {
            const address = message.content.trim();

            if (!/^[1-9A-HJ-NP-Za-km-z]{50,60}$/.test(address)) {
                return message.reply("❌ Please enter a valid Concordium account address.");
            }

            const exists = await pool.query("SELECT * FROM verifications WHERE wallet_address = $1 AND role_type = 'Delegator'", [address]);
            if (exists.rowCount > 0) {
                return message.reply("❌ This address is already registered as a Delegator. Please check the address or contact a moderator.");
            }

            const cmd = `${CLIENT_PATH} account show ${address} --grpc-ip grpc.mainnet.concordium.software --secure`;
            exec(cmd, async (err, stdout) => {
                if (err || !stdout.includes("Delegation target:")) {
                    return message.reply("❌ This address is not currently delegating to any staking pool.");
                }

                const stakeMatch = stdout.match(/Staked amount: ([\d.]+) CCD/);
                const stakedAmount = stakeMatch ? parseFloat(stakeMatch[1]) : 0;

                if (stakedAmount < 1000) {
                    return message.reply(`❌ Your staked amount is **${stakedAmount} CCD**, which is below the required **1000 CCD**.`);
                }

                delegatorVerificationState.set(message.author.id, {
                    ...state,
                    step: "awaiting-tx-hash",
                    delegatorAddress: address
                });

                await message.reply(`✅ Great! Now send a CCD transaction **from your wallet to any address**, using the following as the **MEMO**:\n\`${address}\`\n\nThen reply here with the **transaction hash**. Please note: transaction age must not exceed 1 hour.`);
            });
        }

        if (state.step === "awaiting-tx-hash") {
            const txHash = message.content.trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(txHash)) {
                return message.reply("❌ Please enter a valid 64-character transaction hash.");
            }

            const cmd = `${CLIENT_PATH} transaction status ${txHash} --grpc-ip grpc.mainnet.concordium.software --secure`;
            exec(cmd, async (err, stdout) => {
                if (err || !stdout.includes("Transaction is finalized") || !stdout.includes('with status "success"')) {
                    return message.reply("❌ Transaction is not finalized or was not successful.");
                }

                const { delegatorAddress } = state;

                const senderMatch = stdout.match(/from account '([^']+)'/);
                const memoMatch = stdout.match(/Transfer memo:\n(.+)/);
                const blockHashMatch = stdout.match(/Transaction is finalized into block ([0-9a-fA-F]{64})/);

                const sender = senderMatch?.[1];
                const memo = memoMatch?.[1]?.trim();
                const blockHash = blockHashMatch?.[1];

                if (!sender || !memo) {
                    return message.reply("❌ Could not read sender or memo from transaction.");
                }

                if (sender !== delegatorAddress) {
                    return message.reply(`❌ Sender address must match the address you submitted: \`${delegatorAddress}\``);
                }

                if (memo !== delegatorAddress) {
                    return message.reply(`❌ The MEMO must exactly match your delegator address: \`${delegatorAddress}\`\nMake sure you included it exactly as-is when sending the transaction.`);
                }

                if (!blockHash) {
                    return message.reply("❌ Unable to extract block hash to validate transaction time.");
                }

                const getTimestampCmd = `${CLIENT_PATH} block show ${blockHash} --grpc-ip grpc.mainnet.concordium.software --secure | awk -F': +' '/Block time/ {print $2}'`;

                exec(getTimestampCmd, async (timeErr, timeStdout) => {
                    if (timeErr || !timeStdout.trim()) {
                        return message.reply("❌ Failed to retrieve block timestamp.");
                    }

                    const txTimestamp = Date.parse(timeStdout.trim()) / 1000;
                    const currentTimestamp = Math.floor(Date.now() / 1000);

                    if (currentTimestamp - txTimestamp > 3600) {
                        return message.reply("❌ This transaction is older than 1 hour. Please submit a fresh one.");
                    }

                    const txExists = await pool.query("SELECT * FROM verifications WHERE tx_hash = $1", [txHash]);
                    if (txExists.rowCount > 0) {
                        return message.reply("❌ This transaction has already been used.");
                    }

                    await pool.query(
                        "INSERT INTO verifications (tx_hash, wallet_address, discord_id, role_type) VALUES ($1, $2, $3, $4)",
                        [txHash, delegatorAddress, message.author.id, "Delegator"]
                    );

                    const guild = await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(message.author.id);
                    await member.roles.add(DELEGATOR_ROLE_ID);
                    console.log(`Role 'delegator' successfully assigned to user ${message.author.id}`);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("archive_thread_delegator")
                            .setLabel("🗑️ Delete this thread")
                            .setStyle(ButtonStyle.Secondary)
                    );

                    await message.reply({
                        content: "🎉 You have been successfully verified as a **Delegator** and your role has been assigned! You can now delete this thread.",
                        components: [row]
                    });

                    delegatorVerificationState.delete(message.author.id);
                });
            });
        }
    });

    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isButton()) return;

        if (interaction.customId === "archive_thread_delegator") {
            try {
                await interaction.channel.delete("Thread deleted after successful delegator verification.");
            } catch (err) {
                console.error("Thread archiving failed:", err);
                await interaction.reply({
                    content: "❌ Failed to archive thread. Please try again later.",
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    });
}

module.exports = {
    handleDelegatorVerification,
    listenForDelegatorMessages,
    restartDelegatorFlow: async function (interaction, client) {
        const discordId = interaction.user.id;

        const existingState = delegatorVerificationState.get(discordId);
        if (!existingState) {
            return interaction.reply({
                content: "⚠️ You don't have an active verification thread. Please start the verification using the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        const thread = await client.channels.fetch(existingState.threadId).catch(() => null);
        if (!thread) {
            delegatorVerificationState.delete(discordId);
            return interaction.reply({
                content: "⚠️ Your previous verification thread could not be found. Please start again from the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        delegatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-account-address"
        });

        await thread.send(`<@${interaction.user.id}> 🔁 Verification has been restarted.\nPlease send your **account address** again. You must delegate at least **1000 CCD**.\n\nIf you entered the wrong address again, you can use \`/start-again-delegator\` once more.`);
        await interaction.reply({
            content: "🔄 Verification process restarted in your existing thread.",
            flags: MessageFlags.Ephemeral
        });
    }
};