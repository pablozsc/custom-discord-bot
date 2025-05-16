const { ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { exec } = require("child_process");
const { Pool } = require("pg");

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAIM_CHANNEL_ID = process.env.CLAIM_CHANNEL_ID;
const VALIDATOR_ROLE_ID = process.env.VALIDATOR_ROLE_ID;
const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const validatorVerificationState = new Map();

async function handleValidatorVerification(interaction, discordId, client) {
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);

        if (member.roles.cache.has(VALIDATOR_ROLE_ID)) {
            await interaction.reply({
                content: "✅ You already have the **Validator** role — no need to verify again.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (validatorVerificationState.has(discordId)) {
            const existing = validatorVerificationState.get(discordId);
            const existingThread = await client.channels.fetch(existing.threadId).catch(() => null);

            if (existingThread) {
                await interaction.reply({
                    content: `⚠️ You already have an active verification thread.\n👉 [Open thread](https://discord.com/channels/${GUILD_ID}/${existingThread.id})`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            } else {
                validatorVerificationState.delete(discordId);
            }
        }

        const verificationChannel = await client.channels.fetch(CLAIM_CHANNEL_ID);
        const thread = await verificationChannel.threads.create({
            name: `validator-${interaction.user.username}`,
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 60,
            reason: `Validator verification for ${interaction.user.tag}`
        });

        await thread.members.add(interaction.user.id);

        validatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-validator-id"
        });

        await interaction.reply({
            content: `📩 Verification started.\n👉 [Click here to open your thread](https://discord.com/channels/${GUILD_ID}/${thread.id})`,
            flags: MessageFlags.Ephemeral
        });

        await thread.send(`<@${interaction.user.id}> Please send your **validator ID** to begin verification (e.g. 12345).\n\nIf you entered the wrong ID, you can use the command \`/start-again-validator\` to restart.`);
    } catch (err) {
        console.error("Validator verification thread error:", err);
        await interaction.reply({
            content: "❌ Failed to start validator verification. Please contact a moderator.",
            flags: MessageFlags.Ephemeral
        });
    }
}

function listenForValidatorMessages(client) {
    client.on("messageCreate", async (message) => {
        if (!message.channel.isThread()) return;
        if (message.author.bot) return;

        const state = validatorVerificationState.get(message.author.id);
        if (!state || state.threadId !== message.channel.id) return;

        if (state.step === "awaiting-validator-id") {
            const validatorId = message.content.trim();
            if (!/^\d+$/.test(validatorId)) {
                return message.reply("❌ Please enter a valid numeric validator ID.");
            }

            const cmd = `${CLIENT_PATH} consensus show-parameters --include-bakers --grpc-ip grpc.mainnet.concordium.software --secure | awk '$1 ~ /^${validatorId}:$/ {print $2}'`;

            exec(cmd, async (err, stdout) => {
                if (err || !stdout.trim()) {
                    return message.reply("❌ Failed to retrieve validator address. Please double-check the ID.");
                }

                const validatorAddress = stdout.trim();

                const exists = await pool.query("SELECT * FROM verifications WHERE wallet_address = $1 AND role_type = 'Validator'", [validatorAddress]);
                if (exists.rowCount > 0) {
                    return message.reply("❌ This validator address is already registered. Please check the ID or contact a moderator.");
                }

                validatorVerificationState.set(message.author.id, {
                    ...state,
                    step: "awaiting-tx-hash",
                    validatorId,
                    validatorAddress
                });

                await message.reply(`✅ Your validator address is: \`${validatorAddress}\`\n\nNow send a CCD transaction **from this address to any address**, using your **validator ID** (\`${validatorId}\`) as the MEMO. Then reply here with the transaction hash. Please note: transaction age must not exceed 1 hour.`);
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

                const { validatorId, validatorAddress } = state;

                const senderMatch = stdout.match(/from account '([^']+)'/);
                const memoMatch = stdout.match(/Transfer memo:\n(.+)/);
                const blockHashMatch = stdout.match(/Transaction is finalized into block ([0-9a-fA-F]{64})/);

                const sender = senderMatch?.[1];
                const memo = memoMatch?.[1]?.trim();
                const blockHash = blockHashMatch?.[1];

                if (!sender || sender !== validatorAddress) {
                    return message.reply(`❌ Sender address must match the validator address: \`${validatorAddress}\``);
                }

                if (!memo || memo !== validatorId) {
                    return message.reply(`❌ The MEMO must exactly match your validator ID: \`${validatorId}\``);
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
                        [txHash, validatorAddress, message.author.id, "Validator"]
                    );

                    const guild = await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(message.author.id);
                    await member.roles.add(VALIDATOR_ROLE_ID);
                    console.log(`Role 'validator' successfully assigned to user ${message.author.id}`);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("archive_thread_validator")
                            .setLabel("🗑️ Delete this thread")
                            .setStyle(ButtonStyle.Secondary)
                    );

                    await message.reply({
                        content: "🎉 You have been successfully verified as a **Validator** and your role has been assigned! You can now delete this thread.",
                        components: [row]
                    });

                    validatorVerificationState.delete(message.author.id);
                });
            });
        }
    });

    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isButton()) return;

        if (interaction.customId === "archive_thread_validator") {
            try {
                await interaction.channel.delete("Thread deleted after successful validator verification.");
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
    handleValidatorVerification,
    listenForValidatorMessages,
    restartValidatorFlow: async function (interaction, client) {
        const discordId = interaction.user.id;

        const existingState = validatorVerificationState.get(discordId);
        if (!existingState) {
            return interaction.reply({
                content: "⚠️ You don't have an active verification thread. Please start the verification using the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        const thread = await client.channels.fetch(existingState.threadId).catch(() => null);
        if (!thread) {
            validatorVerificationState.delete(discordId);
            return interaction.reply({
                content: "⚠️ Your previous verification thread could not be found. Please start again from the dropdown menu.",
                flags: MessageFlags.Ephemeral
            });
        }

        validatorVerificationState.set(discordId, {
            threadId: thread.id,
            step: "awaiting-validator-id"
        });

        await thread.send(`<@${interaction.user.id}> 🔁 Verification has been restarted.\nPlease send your **validator ID** again (e.g. \`12345\`).\nIf you entered the wrong ID again, you can use \`/start-again-validator\` once more.`);

        await interaction.reply({
            content: "🔄 Verification process restarted in your existing thread.",
            flags: MessageFlags.Ephemeral
        });
    }
};