require("dotenv").config();
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
const fs = require("fs");
// const https = require("https");
const { Server } = require("socket.io");
// const httpServer = http.createServer(app);
var options = {
  key: fs.readFileSync("/etc/letsencrypt/live/devn.rglabs.net/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/devn.rglabs.net/fullchain.pem"),
};
var https = require("https");
var httpServer = https.createServer(options, app);
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mainConfig = require("./config");
const AccessToken = require("twilio").jwt.AccessToken;
const { VideoGrant } = AccessToken;
const corsOptions = {
  origin: "*",
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use("/public", express.static("public"));
app.use(express.json());
app.use("/", express.static(path.join(__dirname, "build")));

const twilioClient = require("twilio")(
  process.env.TWILIO_API_KEY_SID,
  process.env.TWILIO_API_KEY_SECRET,
  { accountSid: process.env.TWILIO_ACCOUNT_SID }
);

const findOrCreateRoom = async (roomName) => {
  try {
    // see if the room exists already. If it doesn't, this will throw
    // error 20404.
    await twilioClient.video.v1.rooms(roomName).fetch();
  } catch (error) {
    // the room was not found, so create it
    if (error.code == 20404) {
      await twilioClient.video.v1.rooms.create({
        uniqueName: roomName,
        type: "go",
      });
    } else {
      // let other errors bubble up
      throw error;
    }
  }
};

const getAccessToken = (roomName) => {
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity: uuidv4() }
  );

  const videoGrant = new VideoGrant({
    room: roomName,
  });

  token.addGrant(videoGrant);
  return token.toJwt();
};

app.post("/join-room", async (req, res) => {
  if (!req.body || !req.body.roomName) {
    return res.status(400).send("Must include roomName argument.");
  }
  const roomName = req.body.roomName;
  findOrCreateRoom(roomName);
  const token = getAccessToken(roomName);
  res.send({
    token: token,
  });
});

// app.get("/token", (req, res) => {
//   const twilioAccountSid = "AC772ba286f2d74794765f57d8a3ca4bf0";
//   const twilioApiKey = "SK85ef754c6731a3a8155f9b7cf62e4730";
//   const twilioApiSecret = "PjH3C6XoKxfcXsiJlT5DG8ZG7aZEeg5p";
//   const identity = uuidv4();
//   const token = new AccessToken(
//     twilioAccountSid,
//     twilioApiKey,
//     twilioApiSecret,
//     { identity: identity }
//   );

//   token.identity = identity;

//   const videoGrant = new VideoGrant({
//     room: "chat-app",
//   });
//   token.addGrant(videoGrant);

//   const jwtToken = token.toJwt();
//   res.json({ token: jwtToken, identity: identity });
// });

app.get("/*", function (req, res) {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    preflightContinue: false,
    optionsSuccessStatus: 204,
  },
});

io.on("connection", (socket) => {
  socket.join("global");

  socket.on("login", async (data) => {
    const { username } = data;

    const allSockets = await io.fetchSockets();
    const userSockets = allSockets.filter(
      (s) => s?.data?.user?.username === username
    );

    if (userSockets.length > 0)
      return socket.emit("login", { error: "Username already taken" });

    var user = {
      username,
    };

    if (username.includes(mainConfig.verifiedNames)) {
      user = {
        username,
        verified: true,
      };
    } else {
      user = {
        username,
      };
    }

    socket.data.user = user;
    socket.emit("login", {
      success: true,
      data: user,
    });
  });

  socket.on("fetchUser", () => {
    const user = socket.data.user;
    if (user) {
      socket.emit("user", user);
    } else {
      socket.emit("user", null);
    }
  });

  socket.on("fetchRooms", () => {
    setInterval(async () => {
      const rooms = io.sockets.adapter.rooms;
      const allRooms = (
        await Promise.all(
          Object.keys(rooms).map(async (room) => {
            const sockets = await io.in(room).fetchSockets();
            const users = sockets.map((s) => s.data.user);
            return {
              id: room,
              name: rooms[room]?.name,
              owner: rooms[room]?.owner,
              passwordProtected: rooms[room]?.password ? true : false,
              maxUsers: rooms[room]?.maxUsers,
              users: users.length,
              distance: rooms[room],
            };
          })
        )
      ).filter((r) => r.name !== "global");
      socket.emit("rooms", {
        isLogged: socket.data?.user !== undefined ? true : false,
        user: socket.data?.user,
        rooms: allRooms.filter((item) => item.users === 1),
      });

      const allSockets = await io.fetchSockets();
      const users = allSockets.filter((s) => s?.data?.user?.username);
      const usersonline = users.length;

      socket.emit("UsersOnline", { success: true, users: usersonline });
    }, 1000);
  });

  socket.on("UsersOnline", async () => {
    socket.emit("UsersOnline", { success: true });
  });

  socket.on("createRoom", (data) => {
    const { name, password, maxUsers, latitude, longitude } = data;
    if (!name)
      return socket.emit("createRoom", {
        success: false,
        error: "Name is required",
      });
    if (io.sockets.adapter.rooms[name])
      return socket.emit("createRoom", {
        success: false,
        error: "Room already exists",
      });
    let room = {
      id: Math.random().toString(36).substring(2, 9),
      name: name.replace(/[^a-zA-Z0-9 ]/g, ""),
      owner: socket.data.user,
      users: 1,
      maxUsers: maxUsers,
      latitude: latitude,
      longitude: longitude,
    };

    if (password) room.password = password;

    io.sockets.adapter.rooms[room.id] = room;

    socket.rooms.forEach((user_room) => {
      socket.leave(user_room);
      updateMembers(user_room);
      socket.to(user_room).emit("message", {
        system: true,
        message: `stranger left the room`,
      });
    });
    socket.join(room.id);
    socket.emit("createRoom", { success: true, data: room });
  });

  socket.on("joinRoom", async (data) => {
    const { id, password } = data;
    if (!id)
      return socket.emit("joinRoom", {
        success: false,
        error: "Room id is required",
      });
    if (!io.sockets.adapter.rooms[id])
      return socket.emit("joinRoom", {
        success: false,
        error: "Room not found",
      });

    const room = io.sockets.adapter.rooms[id];
    if (room.password && room.password !== password)
      return socket.emit("joinRoom", {
        success: false,
        error: "Wrong password",
      });
    const sockets = await io.in(id).fetchSockets();
    if (sockets.length >= room.maxUsers)
      return socket.emit("joinRoom", {
        success: false,
        error: "Room is full",
      });
    if (sockets.find((s) => s.data.user.username === socket.data.user.username))
      return socket.emit("joinRoom", {
        success: false,
        alreadyIn: true,
        error: "You are already in this room",
      });

    socket.rooms.forEach((user_room) => {
      socket.leave(user_room);
      updateMembers(user_room);
      socket.to(user_room).emit("message", {
        system: true,
        message: `stranger left the room`,
      });
    });

    socket.join(id);

    updateMembers(id);
    socket.emit("joinRoom", { success: true, data: room });
    socket.to(id).emit("message", {
      system: true,
      message: `stranger joined the room`,
    });
  });

  socket.on("joinRoomStranger", async (data) => {
    const { id, password } = data;
    if (!id)
      return socket.emit("joinRoomStranger", {
        success: false,
        error: "Room id is required",
      });
    if (!io.sockets.adapter.rooms[id])
      return socket.emit("joinRoomStranger", {
        success: false,
        error: "Room not found",
      });

    const room = io.sockets.adapter.rooms[id];
    if (room.password && room.password !== password)
      return socket.emit("joinRoomStranger", {
        success: false,
        error: "Wrong password",
      });
    const sockets = await io.in(id).fetchSockets();
    if (sockets.length >= room.maxUsers)
      return socket.emit("joinRoomStranger", {
        success: false,
        error: "Room is full",
      });
    if (
      sockets.find(
        (s) => s?.data?.user?.username === socket?.data?.user?.username
      )
    )
      return socket.emit("joinRoomStranger", {
        success: false,
        alreadyIn: true,
        error: "You are already in this room",
      });

    socket.rooms.forEach((user_room) => {
      socket.leave(user_room);
      updateMembers(user_room);
      socket.to(user_room).emit("message", {
        system: true,
        message: `stranger left the room`,
      });
    });

    socket.join(id);

    updateMembers(id);
    socket.emit("joinRoomStranger", { success: true, data: room });
    socket.to(id).emit("message", {
      system: true,
      message: `A stranger joins the room`,
    });
  });

  socket.on("leaveRoom", async () => {
    const room = Array.from(socket.rooms).find((room) => room !== socket.id);
    if (!room)
      return socket.emit("leaveRoom", {
        success: false,
        error: "You are not in a room",
      });
    socket.leaveAll();
    socket.join("global");
    socket.emit("leaveRoom", { success: true });

    updateMembers(room);
    socket.to(room).emit("message", {
      system: true,
      message: `stranger left the room`,
    });
  });

  socket.on("leaveRoomStranger", async (status) => {
    const room = Array.from(socket.rooms).find((room) => room !== socket.id);
    if (!room)
      return socket.emit("leaveRoomStranger", {
        success: false,
        error: "You are not in a room",
      });
    socket.leaveAll();
    socket.join("global");
    socket.emit("leaveRoomStranger", { success: true, status: status });

    socket.to(room).emit("ClearMessages", {
      success: true,
    });

    updateMembers(room);
    socket.to(room).emit("message", {
      system: true,
      message: `Stranger left the room`,
    });
  });

  socket.on("ClearMessages", async () => {
    socket.emit("ClearMessages", { success: true });
  });

  socket.on("IsTypping", async (id) => {
    const room = Array.from(socket.rooms).find((room) => room !== socket.id);
    if (room === id) {
      socket.to(room).emit("IsTypping", {
        success: true,
        user: socket.data.user,
        room: room,
      });
    }
  });

  socket.on("roomMembers", async () => {
    const room = Array.from(socket.rooms).find((room) => room !== socket.id);
    if (!room)
      return socket.emit("roomMembers", {
        success: false,
        error: "You are not in a room",
      });

    updateMembers(room);
  });

  function updateMembers(room) {
    io.in(room)
      .fetchSockets()
      .then((sockets) => {
        const members = sockets.map((socket) => socket.data.user);
        if (members.length > 0) {
          io.in(room).emit("roomMembers", { success: true, data: members });
        } else {
          delete io.sockets.adapter.rooms[room];
        }
      });
  }

  socket.on("message", async (data) => {
    const room = Array.from(socket.rooms).find((room) => room !== socket.id);
    if (!room) return;

    var message = {
      user: data.user,
      message: data.message,
      date: new Date(),
      video: data.video,
    };

    if ((data.file && data.type == "image/jpeg") || data.type == "image/png") {
      message = {
        user: data.user,
        message: data.message,
        date: new Date(),
        file: data.file,
        type: data.type,
        video: data.video,
      };
    }

    const sockets = await io.in(room).fetchSockets();
    sockets.forEach((s) => {
      s.emit("message", {
        ...message,
        self: s.id === socket.id,
      });
    });
  });

  socket.on("fetchRoom", async () => {
    const room = Array.from(socket.rooms).find((room) => room !== socket.id);
    if (!room)
      return socket.emit("fetchRoom", {
        success: false,
        error: "You are not in a room",
      });

    socket.emit("fetchRoom", {
      success: true,
      data: io.sockets.adapter.rooms[room],
    });
  });

  socket.on("disconnect", (data) => {
    socket.rooms.forEach((room) => {
      socket.to(room).emit("message", {
        system: true,
        message: `stranger left the room`,
      });

      updateMembers(room);
    });
    socket.leaveAll();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Your App Is listing http://localhost:${PORT}`);
});
