require("dotenv").config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, SlashCommandBuilder } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require("@discordjs/voice");
const { spawn } = require("child_process");
const yts = require("yt-search");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let currentConnection = null;
let currentPlayer = null;
let queue = [];
let currentSong = null;
let isPlaying = false;
let currentYtDlpProcess = null;
let isSkipping = false;

client.once("ready", async () => {
    console.log(`✅ BeatBuddy is online as ${client.user.tag}`);

    const playCommand = new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song by name or YouTube URL")
        .addStringOption(option =>
            option.setName("song")
                .setDescription("Song name or YouTube URL")
                .setRequired(true)
        );

    const queueCommand = new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Show the current music queue");

    const commands = [playCommand, queueCommand];
    try {
        await client.application.commands.set(commands.map(cmd => cmd.toJSON()));
        console.log("Slash commands registered successfully!");
    } catch (error) {
        console.error("Error registering slash commands:", error);
    }
});

async function playNextSong(message) {
    if (isPlaying) {
        console.log("playNextSong called while already playing, ignoring...");
        return;
    }
    isPlaying = true;
    console.log("Starting playNextSong, currentSong:", currentSong, "queue:", queue);

    if (queue.length === 0 && !currentSong) {
        if (currentConnection) {
            currentConnection.destroy();
            currentConnection = null;
            currentPlayer = null;
            message.channel.send("🎵 Queue is empty, disconnecting...");
            console.log("Queue empty, disconnected");
        }
        isPlaying = false;
        return;
    }

    if (queue.length > 0) {
        currentSong = queue.shift();
        console.log("Shifted next song from queue, new currentSong:", currentSong, "remaining queue:", queue);
    } else {
        currentSong = null;
        isPlaying = false;
        console.log("No more songs in queue, stopping playback");
        return;
    }

    const voiceChannel = message.member.voice.channel;

    if (!currentConnection) {
        currentConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
        });
        console.log("Bot joined voice channel:", voiceChannel.name);

        currentConnection.on(VoiceConnectionStatus.Ready, () => {
            console.log("Voice connection ready");
        });
    }

    if (!currentPlayer) {
        currentPlayer = createAudioPlayer();
        currentConnection.subscribe(currentPlayer);
        console.log("Player subscribed to connection");
    }

    currentYtDlpProcess = spawn("yt-dlp", ["-f", "bestaudio", "-o", "-", currentSong]);
    console.log("Fetching audio with yt-dlp for:", currentSong);

    currentYtDlpProcess.stderr.on("data", (data) => {
        console.error(`yt-dlp stderr: ${data}`);
    });

    currentYtDlpProcess.on("close", (code) => {
        console.log(`yt-dlp closed with code ${code}`);
        if (code !== 0 && !isSkipping) {
            message.channel.send("❌ Failed to play audio.");
        }
        currentYtDlpProcess = null;
    });

    const resource = createAudioResource(currentYtDlpProcess.stdout, { inlineVolume: true });
    resource.volume.setVolume(0.5);
    currentPlayer.play(resource);
    console.log("Playing audio resource");

    const buttons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId("skip")
                .setLabel("Skip")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("pause")
                .setLabel("Pause")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId("play")
                .setLabel("Play")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("queue")
                .setLabel("See queue") // Changed from "Queue" to "See queue"
                .setStyle(ButtonStyle.Primary)
        );

    const channelPermissions = message.channel.permissionsFor(message.guild.members.me);
    if (!channelPermissions.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) {
        console.error("Missing permissions to send buttons: SendMessages or EmbedLinks");
        isPlaying = false;
        return;
    }

    try {
        const searchResults = await yts({ videoId: currentSong.split("v=")[1] });
        const title = searchResults.title || "Unknown Title";
        await message.channel.send({ content: `🎵 Now Playing: ${title}`, components: [buttons] });
        console.log("Buttons sent successfully with song title");
    } catch (error) {
        console.error("Error sending buttons:", error);
        await message.channel.send({ components: [buttons] });
    }

    currentPlayer.on("error", (error) => {
        console.error("Player error:", error.message);
        message.channel.send("❌ Error playing audio.");
        queue = [];
        currentSong = null;
        if (currentConnection) currentConnection.destroy();
        currentConnection = null;
        currentPlayer = null;
        isPlaying = false;
    });

    currentPlayer.on(AudioPlayerStatus.Idle, () => {
        console.log("Audio finished, playing next...");
        if (currentYtDlpProcess) {
            currentYtDlpProcess.kill();
            currentYtDlpProcess = null;
        }
        currentSong = null;
        isPlaying = false;
        setTimeout(() => playNextSong(message), 500);
    });
}

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const args = message.content.split(" ");
    const command = args.shift().toLowerCase();

    if (command === "/play") {
        if (!args[0]) return message.reply("❌ You need to provide a YouTube link or song name!");
        if (!message.member.voice.channel) return message.reply("❌ You need to join a voice channel first!");

        let url = args.join(" ");

        if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/)) {
            const searchResults = await yts(url);
            if (!searchResults.videos.length) return message.reply("❌ No songs found!");
            url = searchResults.videos[0].url;
        }

        queue.push(url);
        console.log("Queue after adding:", queue);

        if (!currentPlayer || currentPlayer.state.status === AudioPlayerStatus.Idle) {
            playNextSong(message);
        } else {
            const searchResults = await yts({ videoId: url.split("v=")[1] });
            const title = searchResults.title || "Unknown Title";
            message.reply(`🎵 Added to queue: ${title}`);
        }
    }

    if (command === "/queue") {
        if (args.length > 0) {
            return message.reply("❌ The `/queue` command does not take arguments. To add a song, use `/play <song name>`. To view the queue, just type `/queue` or use the See queue button.");
        }

        console.log("Queue command triggered, current queue:", queue, "Current song:", currentSong);
        if (!currentSong && queue.length === 0) return message.reply("❌ The queue is empty!");

        let queueMessage = "";
        if (currentSong) {
            const searchResults = await yts({ videoId: currentSong.split("v=")[1] });
            const title = searchResults.title || "Unknown Title";
            queueMessage += `🎵 Now Playing: ${title}\n`;
        }
        if (queue.length > 0) {
            let queueList = "";
            for (let i = 0; i < queue.length; i++) {
                const searchResults = await yts({ videoId: queue[i].split("v=")[1] });
                const title = searchResults.title || "Unknown Title";
                queueList += `${i + 1}. ${title}\n`;
            }
            queueMessage += `📜 Queue:\n${queueList}`;
        } else {
            queueMessage += "📜 Queue: (empty)";
        }
        message.reply(queueMessage);
    }

    if (command === ".") {
        if (!currentConnection) return message.reply("❌ I'm not in a voice channel!");
        if (currentPlayer) currentPlayer.stop();
        if (currentYtDlpProcess) {
            currentYtDlpProcess.kill();
            currentYtDlpProcess = null;
        }
        currentConnection.destroy();
        currentConnection = null;
        currentPlayer = null;
        queue = [];
        currentSong = null;
        isPlaying = false;
        message.reply("👋 BeatBuddy has left the channel");
        console.log("Bot left the voice channel");
    }
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.isCommand()) {
        if (interaction.commandName === "play") {
            const song = interaction.options.getString("song");
            if (!interaction.member.voice.channel) {
                return interaction.reply("❌ You need to join a voice channel first!");
            }

            let url = song;

            if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/)) {
                const searchResults = await yts(url);
                if (!searchResults.videos.length) return interaction.reply("❌ No songs found!");
                url = searchResults.videos[0].url;
            }

            queue.push(url);
            console.log("Queue after adding:", queue);

            if (!currentPlayer || currentPlayer.state.status === AudioPlayerStatus.Idle) {
                await interaction.deferReply({ flags: 64 });
                playNextSong(interaction);
                await interaction.deleteReply();
            } else {
                const searchResults = await yts({ videoId: url.split("v=")[1] });
                const title = searchResults.title || "Unknown Title";
                await interaction.reply(`🎵 Added to queue: ${title}`);
            }
        }

        if (interaction.commandName === "queue") {
            console.log("Queue command triggered, current queue:", queue, "Current song:", currentSong);
            if (!currentSong && queue.length === 0) return interaction.reply("❌ The queue is empty!");

            let queueMessage = "";
            if (currentSong) {
                const searchResults = await yts({ videoId: currentSong.split("v=")[1] });
                const title = searchResults.title || "Unknown Title";
                queueMessage += `🎵 Now Playing: ${title}\n`;
            }
            if (queue.length > 0) {
                let queueList = "";
                for (let i = 0; i < queue.length; i++) {
                    const searchResults = await yts({ videoId: queue[i].split("v=")[1] });
                    const title = searchResults.title || "Unknown Title";
                    queueList += `${i + 1}. ${title}\n`;
                }
                queueMessage += `📜 Queue:\n${queueList}`;
            } else {
                queueMessage += "📜 Queue: (empty)";
            }
            await interaction.reply(queueMessage);
        }
    }

    if (interaction.isButton()) {
        if (!currentConnection) {
            await interaction.reply({ content: "❌ I'm not in a voice channel!", flags: [4096] });
            return;
        }

        const botVoiceChannel = currentConnection.joinConfig.channelId;
        const userVoiceChannel = interaction.member.voice.channelId;

        if (!userVoiceChannel || userVoiceChannel !== botVoiceChannel) {
            await interaction.reply({ content: "❌ You need to be in the same voice channel as me to use these buttons!", flags: [4096] });
            return;
        }

        if (!currentPlayer) {
            await interaction.reply({ content: "❌ Nothing is playing!", flags: [4096] });
            return;
        }

        if (interaction.customId === "skip") {
            isSkipping = true;
            if (currentYtDlpProcess) {
                currentYtDlpProcess.kill();
                currentYtDlpProcess = null;
            }
            currentPlayer.stop();
            await interaction.reply("⏭️ Skipped the current song!");
            console.log("Song skipped, moving to next, currentSong:", currentSong, "queue:", queue);
            isPlaying = false;
            isSkipping = false;
            playNextSong(interaction.message);
        }

        if (interaction.customId === "pause") {
            if (currentPlayer.state.status === AudioPlayerStatus.Paused) {
                await interaction.reply({ content: "⏸️ Already paused!", flags: [4096] });
            } else {
                currentPlayer.pause();
                const buttons = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId("play")
                            .setLabel("Play")
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId("skip")
                            .setLabel("Skip")
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId("queue")
                            .setLabel("See queue") // Changed from "Queue" to "See queue"
                            .setStyle(ButtonStyle.Primary)
                    );
                await interaction.reply({ content: "⏸️ Paused the music!", components: [buttons] });
                console.log("Music paused");
            }
        }

        if (interaction.customId === "play") {
            if (currentPlayer.state.status === AudioPlayerStatus.Playing) {
                await interaction.reply({ content: "▶️ Already playing!", flags: [4096] });
            } else {
                await interaction.deferReply({ ephemeral: true });
                currentPlayer.unpause();
                await interaction.editReply({ content: "▶️ Resumed the music!" });
                console.log("Music resumed");
            }
        }

        if (interaction.customId === "queue") {
            console.log("Queue button triggered, current queue:", queue, "Current song:", currentSong);
            if (!currentSong && queue.length === 0) {
                await interaction.reply({ content: "❌ The queue is empty!", flags: [4096] });
                return;
            }

            let queueMessage = "";
            if (currentSong) {
                const searchResults = await yts({ videoId: currentSong.split("v=")[1] });
                const title = searchResults.title || "Unknown Title";
                queueMessage += `🎵 Now Playing: ${title}\n`;
            }
            if (queue.length > 0) {
                let queueList = "";
                for (let i = 0; i < queue.length; i++) {
                    const searchResults = await yts({ videoId: queue[i].split("v=")[1] });
                    const title = searchResults.title || "Unknown Title";
                    queueList += `${i + 1}. ${title}\n`;
                }
                queueMessage += `📜 Queue:\n${queueList}`;
            } else {
                queueMessage += "📜 Queue: (empty)";
            }
            await interaction.reply({ content: queueMessage, flags: [4096] });
        }
    }
});

client.login(process.env.TOKEN);