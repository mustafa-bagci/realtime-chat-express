import express from "express";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import session from "express-session";
import http from "http";
import { Server } from "socket.io";
import dotenv from 'dotenv';
import pkg from "pg";
const { Client } = pkg;

dotenv.config();

const app = express();
const port = 3000;

const db = new Client({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
});

db.connect();

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "your-secret-key",
    resave: false,
    saveUninitialized: true,
  })
);

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/chat");
  }
  res.render("index.ejs");
});

app.get("/register", (req, res) => {
  res.render("register.ejs");
});

app.post("/register", async (req, res) => {
  const { firstname, lastname, email, password, confirmpassword } = req.body;

  try {
    const checkResult = await db.query("SELECT * FROM users WHERE email = $1", [email]);

    if (checkResult.rows.length > 0) {
      return res.render("register.ejs", { error: "Email already exists. Try logging in." });
    }

    if (password !== confirmpassword) {
      return res.render("register.ejs", { passwordError: "Passwords do not match." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO users (first_name, last_name, email, password) VALUES ($1, $2, $3, $4)",
      [firstname, lastname, email, hashedPassword]
    );

    res.redirect("/chat");
  } catch (err) {
    console.log(err);
    res.render("register.ejs", { error: "An unexpected error occurred." });
  }
});

app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const match = await bcrypt.compare(password, user.password);

      if (match) {
        req.session.user = user;
        res.redirect("/chat");
      } else {
        res.render("login.ejs", { error: "Incorrect Password" });
      }
    } else {
      res.render("login.ejs", { error: "Incorrect Email" });
    }
  } catch (err) {
    console.log(err);
  }
});

app.get("/chat", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  const userId = req.session.user.id;
  try {
    const friendsQuery = await db.query(
      "SELECT u.id, u.first_name, u.last_name FROM users u JOIN friends f ON (f.user_id = u.id OR f.friend_id = u.id) WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted' AND u.id != $1",
      [userId]
    );

    const friends = friendsQuery.rows;
    res.render("chat.ejs", { user: req.session.user, friends });
  } catch (err) {
    console.log(err);
    res.render("chat.ejs", { error: "Error loading friends." });
  }
});

app.get("/chat/:friendId", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const friendId = req.params.friendId;

    console.log("Fetching messages for:", { userId, friendId });

    const friendsQuery = await db.query(
      "SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2 AND status = 'accepted') OR (user_id = $2 AND friend_id = $1 AND status = 'accepted')",
      [userId, friendId]
    );

    if (friendsQuery.rows.length === 0) {
      console.log("No friendship found");
      return res.redirect("/chat");
    }

    const messagesQuery = await db.query(
      "SELECT * FROM messages WHERE (from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1) ORDER BY created_at",
      [userId, friendId]
    );

    const messages = messagesQuery.rows;

    if (messages.length === 0) {
      return res.render("chatWithFriend.ejs", {
        user: req.session.user,
        friendId,
        message: "Pas encore de messages avec cet ami.",
      });
    }

    res.render("chatWithFriend.ejs", { user: req.session.user, friendId, messages });
  } catch (err) {
    console.error("Error fetching chat messages:", err);
    res.status(500).send("An error occurred while loading messages.");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.redirect("/chat");
    }
    res.redirect("/login");
  });
});

app.post("/addFriend", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).send({ error: "Email is required." });
  }

  const userId = req.session.user.id;

  try {
    const friend = await db.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);

    if (friend.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }

    const friendId = friend.rows[0].id;

    const existingFriendship = await db.query(
      "SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)",
      [userId, friendId]
    );

    if (existingFriendship.rows.length > 0) {
      return res.status(400).send({ error: "Friendship already exists or is pending" });
    }

    await db.query(
      "INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')",
      [userId, friendId]
    );

    res.send({ success: "Friend request sent" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "An error occurred" });
  }
});

app.get("/friendRequests", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send({ error: "User not logged in" });
  }

  const userId = req.session.user.id;

  try {
    const friendRequestsQuery = await db.query(
      "SELECT u.id, u.first_name, u.last_name FROM users u JOIN friends f ON u.id = f.user_id WHERE f.friend_id = $1 AND f.status = 'pending'",
      [userId]
    );

    const friendRequests = friendRequestsQuery.rows || [];
    
    const formattedRequests = friendRequests.map(request => {
      return {
        id: request.id,
        name: `${request.first_name} ${request.last_name}`
      };
    });

    res.json({ friendRequests: formattedRequests });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Error fetching friend requests." });
  }
});

app.post("/acceptFriendRequest", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send({ error: "User not logged in" });
  }

  const { friendId } = req.body;
  const userId = req.session.user.id;

  try {
    const result = await db.query(
      "UPDATE friends SET status = 'accepted' WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'",
      [friendId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(400).send({ error: "Friend request not found or already accepted" });
    }

    res.json({ message: "Friend request accepted" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Error accepting friend request" });
  }
});

app.post("/declineFriendRequest", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send({ error: "User not logged in" });
  }

  const { friendId } = req.body; 
  const userId = req.session.user.id;

  try {
    const result = await db.query(
      "DELETE FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'",
      [friendId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(400).send({ error: "Friend request not found" });
    }

    res.json({ message: "Friend request declined" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Error declining friend request" });
  }
});

app.get('/messages/:friendId', async (req, res) => {
  const { friendId } = req.params;
  
  try {
    const messages = await getMessagesForFriend(req.session.user.id, friendId);

    if (!messages || messages.length === 0) {
      return res.status(404).json({ error: 'No messages found' });
    }

    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function getMessagesForFriend(userId, friendId) {
  const query = `
    SELECT m.from_user_id, m.message, m.created_at, u.first_name, u.last_name
    FROM messages m
    JOIN users u ON m.from_user_id = u.id
    WHERE (m.from_user_id = $1 AND m.to_user_id = $2) 
       OR (m.from_user_id = $2 AND m.to_user_id = $1)
    ORDER BY m.created_at ASC
  `;
  
  try {
    const { rows } = await db.query(query, [userId, friendId]);
    
    const formattedMessages = rows.map(msg => {
      const formattedDate = new Date(msg.created_at).toLocaleString();
      return {
        ...msg,
        timestamp: formattedDate
      };
    });

    return formattedMessages;
  } catch (err) {
    console.error('Error fetching messages:', err);
    return [];
  }
}

let onlineUsers = {};

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("setUser", (userId) => {
    onlineUsers[userId] = socket.id;
    console.log(`User ${userId} connected with socket ID ${socket.id}`);
  });

  socket.on("sendMessage", async (data) => {
    const { from_user_id, to_user_id, message } = data;
  
    try {
      const friendship = await db.query(
        "SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2 AND status = $3) OR (user_id = $2 AND friend_id = $1 AND status = $3)",
        [from_user_id, to_user_id, "accepted"]
      );
  
      if (friendship.rows.length === 0) {
        socket.emit("error", { message: "You must be friends to send a message." });
        return; 
      }
  
      const senderResult = await db.query(
        "SELECT first_name, last_name FROM users WHERE id = $1",
        [from_user_id]
      );
  
      if (senderResult.rows.length === 0) {
        socket.emit("error", { message: "Sender not found." });
        return;
      }
  
      const senderFullName = `${senderResult.rows[0].first_name} ${senderResult.rows[0].last_name}`;
  
      await db.query(
        "INSERT INTO messages (from_user_id, to_user_id, message) VALUES ($1, $2, $3)",
        [from_user_id, to_user_id, message]
      );
  
      if (onlineUsers[to_user_id]) {
        io.to(onlineUsers[to_user_id]).emit("newMessage", { from_user_id, senderFullName, message });
      }
  
      socket.emit("messageSent", { message });
    } catch (err) {
      console.log("Error in sendMessage:", err);
      socket.emit("error", { message: "Error sending message." });
    }
  });
  
  socket.on("disconnect", () => {
    console.log("User disconnected");
    for (let userId in onlineUsers) {
      if (onlineUsers[userId] === socket.id) {
        delete onlineUsers[userId];
        console.log(`User ${userId} disconnected`);
        break;
      }
    }
  });
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});