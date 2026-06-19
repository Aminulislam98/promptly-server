const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { toNodeHandler } = require("better-auth/node");

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// cors must allow credentials for Better Auth cookies
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);

// Better Auth handler — must come before express.json()
const { auth } = require("./auth");
app.all("/api/auth/*", toNodeHandler(auth));

app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Promptly server is running!");
});

async function run() {
  try {
    await client.connect();

    const db = client.db("promptly");

    const usersCollection = db.collection("users");
    const promptsCollection = db.collection("prompts");
    const reviewsCollection = db.collection("reviews");
    const bookmarksCollection = db.collection("bookmarks");
    const paymentsCollection = db.collection("payments");
    const reportsCollection = db.collection("reports");
    const creatorRequestsCollection = db.collection("creatorRequests");

    // verify token using Better Auth session
    const verifyToken = async (req, res, next) => {
      try {
        const session = await auth.api.getSession({
          headers: req.headers,
        });
        if (!session) return res.status(401).send({ message: "Unauthorized" });
        req.user = session.user;
        next();
      } catch {
        return res.status(401).send({ message: "Unauthorized" });
      }
    };

    // verify admin role
    const verifyAdmin = (req, res, next) => {
      if (req.user?.role !== "admin")
        return res.status(403).send({ message: "Forbidden" });
      next();
    };

    // auth routes
    app.post("/api/auth/sync-user", verifyToken, async (req, res) => {
      const existing = await usersCollection.findOne({ email: req.user.email });
      if (!existing) {
        await usersCollection.insertOne({
          email: req.user.email,
          name: req.user.name,
          image: req.user.image || "",
          role: "user",
          isPremium: false,
          createdAt: new Date(),
        });
      }
      res.json({ success: true });
    });

    // prompt routes
    app.get("/api/prompts", async (req, res) => {
      const {
        search,
        category,
        aiTool,
        difficulty,
        sort,
        page = 1,
        limit = 12,
      } = req.query;

      const query = { status: "approved", visibility: "Public" };

      if (search) {
        query.$or = [
          { title: { $regex: search, $options: "i" } },
          { tags: { $regex: search, $options: "i" } },
          { aiTool: { $regex: search, $options: "i" } },
        ];
      }
      if (category && category !== "All") query.category = category;
      if (aiTool && aiTool !== "All") query.aiTool = aiTool;
      if (difficulty && difficulty !== "All") query.difficulty = difficulty;

      let sortOption = { createdAt: -1 };
      if (sort === "copies" || sort === "popular")
        sortOption = { copyCount: -1 };

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const total = await promptsCollection.countDocuments(query);
      const prompts = await promptsCollection
        .find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();

      res.json({ success: true, prompts, total, page: parseInt(page) });
    });

    app.get("/api/prompts/featured", async (req, res) => {
      const prompts = await promptsCollection
        .find({ status: "approved", visibility: "Public" })
        .sort({ copyCount: -1 })
        .limit(6)
        .toArray();
      res.json({ success: true, prompts });
    });

    app.get("/api/prompts/:id", async (req, res) => {
      const prompt = await promptsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!prompt) return res.status(404).send({ message: "Prompt not found" });
      res.json({ success: true, prompt });
    });

    app.post("/api/prompts", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });

      if (!user || user.role === "user") {
        const count = await promptsCollection.countDocuments({
          creatorEmail: req.user.email,
        });
        if (count >= 3)
          return res.status(403).send({
            message: "Free users can only add 3 prompts. Upgrade to Premium.",
          });
      }

      const prompt = {
        ...req.body,
        creatorEmail: req.user.email,
        creatorName: req.user.name,
        copyCount: 0,
        status: "pending",
        featured: false,
        createdAt: new Date(),
      };
      const result = await promptsCollection.insertOne(prompt);
      res.status(201).json({ success: true, result });
    });

    app.patch("/api/prompts/:id", verifyToken, async (req, res) => {
      const filter = {
        _id: new ObjectId(req.params.id),
        creatorEmail: req.user.email,
      };
      const result = await promptsCollection.updateOne(filter, {
        $set: { ...req.body, updatedAt: new Date() },
      });
      res.json({ success: true, result });
    });

    app.delete("/api/prompts/:id", verifyToken, async (req, res) => {
      const query =
        req.user.role === "admin"
          ? { _id: new ObjectId(req.params.id) }
          : { _id: new ObjectId(req.params.id), creatorEmail: req.user.email };
      const result = await promptsCollection.deleteOne(query);
      res.json({ success: true, result });
    });

    app.patch("/api/prompts/:id/copy", verifyToken, async (req, res) => {
      const result = await promptsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $inc: { copyCount: 1 } },
      );
      res.json({ success: true, result });
    });

    app.get("/api/my-prompts", verifyToken, async (req, res) => {
      const prompts = await promptsCollection
        .find({ creatorEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ success: true, prompts });
    });

    // review routes
    app.get("/api/reviews/:promptId", async (req, res) => {
      const reviews = await reviewsCollection
        .find({ promptId: req.params.promptId })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ success: true, reviews });
    });

    app.post("/api/reviews", verifyToken, async (req, res) => {
      const review = {
        ...req.body,
        userEmail: req.user.email,
        createdAt: new Date(),
      };
      const result = await reviewsCollection.insertOne(review);
      res.status(201).json({ success: true, result });
    });

    app.get("/api/my-reviews", verifyToken, async (req, res) => {
      const reviews = await reviewsCollection
        .find({ userEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ success: true, reviews });
    });

    app.delete("/api/reviews/:id", verifyToken, async (req, res) => {
      const result = await reviewsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        userEmail: req.user.email,
      });
      res.json({ success: true, result });
    });

    // bookmark routes
    app.get("/api/bookmarks", verifyToken, async (req, res) => {
      const bookmarks = await bookmarksCollection
        .find({ userEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();

      // populate prompt data
      const populated = await Promise.all(
        bookmarks.map(async (b) => {
          const prompt = await promptsCollection.findOne(
            { _id: new ObjectId(b.promptId) },
            {
              projection: { title: 1, category: 1, aiTool: 1, creatorName: 1 },
            },
          );
          return { ...b, prompt };
        }),
      );

      res.json({ success: true, bookmarks: populated });
    });

    app.post("/api/bookmarks", verifyToken, async (req, res) => {
      const { promptId } = req.body;
      const existing = await bookmarksCollection.findOne({
        promptId,
        userEmail: req.user.email,
      });
      if (existing) {
        await bookmarksCollection.deleteOne({ _id: existing._id });
        return res.json({ success: true, action: "removed" });
      }
      const result = await bookmarksCollection.insertOne({
        promptId,
        userEmail: req.user.email,
        createdAt: new Date(),
      });
      res.status(201).json({ success: true, action: "added", result });
    });

    app.delete("/api/bookmarks/:promptId", verifyToken, async (req, res) => {
      const result = await bookmarksCollection.deleteOne({
        promptId: req.params.promptId,
        userEmail: req.user.email,
      });
      res.json({ success: true, result });
    });

    // report routes
    app.post("/api/reports", verifyToken, async (req, res) => {
      const report = {
        ...req.body,
        reportedBy: req.user.email,
        createdAt: new Date(),
      };
      const result = await reportsCollection.insertOne(report);
      res.status(201).json({ success: true, result });
    });

    // creator request routes
    app.post("/api/creator-requests", verifyToken, async (req, res) => {
      const existing = await creatorRequestsCollection.findOne({
        userEmail: req.user.email,
        status: "pending",
      });
      if (existing)
        return res.status(409).send({ message: "Request already pending" });

      const request = {
        ...req.body,
        userEmail: req.user.email,
        status: "pending",
        createdAt: new Date(),
      };
      const result = await creatorRequestsCollection.insertOne(request);
      res.status(201).json({ success: true, result });
    });

    app.get("/api/creator-requests/status", verifyToken, async (req, res) => {
      const request = await creatorRequestsCollection.findOne({
        userEmail: req.user.email,
      });
      res.json({ success: true, request });
    });

    // user profile
    app.get("/api/users/me", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne(
        { email: req.user.email },
        { projection: { password: 0 } },
      );
      res.json({ success: true, user });
    });

    // top creators aggregation
    app.get("/api/top-creators", async (req, res) => {
      const creators = await promptsCollection
        .aggregate([
          { $match: { status: "approved" } },
          {
            $group: {
              _id: "$creatorEmail",
              name: { $first: "$creatorName" },
              totalPrompts: { $sum: 1 },
              totalCopies: { $sum: "$copyCount" },
            },
          },
          { $sort: { totalCopies: -1 } },
          { $limit: 6 },
        ])
        .toArray();
      res.json({ success: true, creators });
    });

    // payment routes
    app.post("/api/payment/create-checkout", verifyToken, async (req, res) => {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Promptly Premium" },
              unit_amount: 500,
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/payment`,
        customer_email: req.user.email,
      });
      res.json({ success: true, url: session.url });
    });

    app.post("/api/payment/success", verifyToken, async (req, res) => {
      const { sessionId } = req.body;
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid")
        return res.status(400).send({ message: "Payment not completed" });

      await usersCollection.updateOne(
        { email: req.user.email },
        { $set: { isPremium: true } },
      );

      await paymentsCollection.insertOne({
        email: req.user.email,
        name: req.user.name,
        transactionId: session.payment_intent,
        amount: 5,
        status: "success",
        date: new Date(),
      });

      res.json({ success: true, message: "Premium unlocked!" });
    });

    // admin routes
    app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection
        .find({}, { projection: { password: 0 } })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ success: true, users });
    });

    app.patch(
      "/api/admin/users/:id/role",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: req.body.role } },
        );
        res.json({ success: true, result });
      },
    );

    app.delete(
      "/api/admin/users/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.json({ success: true, result });
      },
    );

    app.get(
      "/api/admin/prompts",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const prompts = await promptsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ success: true, prompts });
      },
    );

    app.patch(
      "/api/admin/prompts/:id/approve",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await promptsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "approved" } },
        );
        res.json({ success: true, result });
      },
    );

    app.patch(
      "/api/admin/prompts/:id/reject",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await promptsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: {
              status: "rejected",
              rejectionFeedback: req.body.feedback,
            },
          },
        );
        res.json({ success: true, result });
      },
    );

    app.patch(
      "/api/admin/prompts/:id/feature",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const prompt = await promptsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        const result = await promptsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { featured: !prompt.featured } },
        );
        res.json({ success: true, result });
      },
    );

    app.delete(
      "/api/admin/prompts/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await promptsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.json({ success: true, result });
      },
    );

    app.get(
      "/api/admin/payments",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const payments = await paymentsCollection
          .find({})
          .sort({ date: -1 })
          .toArray();
        res.json({ success: true, payments });
      },
    );

    app.get(
      "/api/admin/reports",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const reports = await reportsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ success: true, reports });
      },
    );

    app.delete(
      "/api/admin/reports/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const result = await reportsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.json({ success: true, result });
      },
    );

    app.post(
      "/api/admin/reports/:id/warn",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const report = await reportsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        await usersCollection.updateOne(
          { email: report.creatorEmail },
          { $push: { warnings: { reason: report.reason, date: new Date() } } },
        );
        res.json({ success: true, message: "Warning sent" });
      },
    );

    app.get(
      "/api/admin/creator-requests",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const requests = await creatorRequestsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ success: true, requests });
      },
    );

    app.patch(
      "/api/admin/creator-requests/:id/approve",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const request = await creatorRequestsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        await usersCollection.updateOne(
          { email: request.userEmail },
          { $set: { role: "creator" } },
        );
        await creatorRequestsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "approved" } },
        );
        res.json({ success: true, message: "User promoted to creator" });
      },
    );

    app.patch(
      "/api/admin/creator-requests/:id/reject",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        await creatorRequestsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "rejected" } },
        );
        res.json({ success: true });
      },
    );

    app.get(
      "/api/admin/analytics",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const [totalUsers, totalPrompts, totalReviews, totalCopiesResult] =
          await Promise.all([
            usersCollection.countDocuments(),
            promptsCollection.countDocuments(),
            reviewsCollection.countDocuments(),
            promptsCollection
              .aggregate([
                { $group: { _id: null, total: { $sum: "$copyCount" } } },
              ])
              .toArray(),
          ]);
        const totalCopies = totalCopiesResult[0]?.total || 0;
        res.json({
          success: true,
          totalUsers,
          totalPrompts,
          totalReviews,
          totalCopies,
        });
      },
    );

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB Atlas");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Promptly server running on port ${port}`);
});
