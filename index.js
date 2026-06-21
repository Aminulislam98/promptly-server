const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 4000;
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());

const uri = process.env.MONGODB_URI;

app.get("/", (req, res) => res.send("Promptly server is running!"));

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("promptly");
    const sessionCollection = db.collection("session");
    const userCollection = db.collection("user");
    const promptsCollection = db.collection("prompts");
    const reviewsCollection = db.collection("reviews");
    const bookmarksCollection = db.collection("bookmarks");
    const paymentsCollection = db.collection("payments");
    const reportsCollection = db.collection("reports");
    const creatorRequestsCollection = db.collection("creatorRequests");

    const verifyToken = async (req, res, next) => {
      const authHeader = req?.headers?.authorization;
      if (!authHeader)
        return res.status(401).send({ message: "unauthorized access" });
      const token = authHeader.split(" ")[1];
      if (!token)
        return res.status(401).send({ message: "unauthorized access" });
      const session = await sessionCollection.findOne({ token });
      if (!session)
        return res.status(401).send({ message: "unauthorized access" });
      if (new Date(session.expiresAt) < new Date())
        return res.status(401).send({ message: "session expired" });
      const user = await userCollection.findOne({ _id: session.userId });
      if (!user)
        return res.status(401).send({ message: "unauthorized access" });
      req.user = user;
      next();
    };

    const verifyAdmin = async (req, res, next) => {
      if (req.user?.role !== "admin")
        return res.status(403).send({ message: "forbidden access" });
      next();
    };

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
      const query = { status: "approved" };
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
      try {
        const prompt = await promptsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!prompt)
          return res.status(404).send({ message: "Prompt not found" });
        res.json({ success: true, prompt });
      } catch {
        res.status(400).send({ message: "Invalid ID" });
      }
    });

    app.post("/api/prompts", verifyToken, async (req, res) => {
      const user = await userCollection.findOne({ email: req.user.email });

      if (user?.isSuspended) {
        return res.status(403).send({
          message: "Your account is suspended. You cannot add prompts.",
        });
      }

      if (user?.role === "user") {
        const count = await promptsCollection.countDocuments({
          creatorEmail: req.user.email,
        });
        if (count >= 3)
          return res.status(403).send({
            message:
              "Free users can only add 3 prompts. Become a Creator to publish unlimited prompts.",
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
      res.json({ success: true, result });
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
      res.json({ success: true, result });
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
      const populated = await Promise.all(
        bookmarks.map(async (b) => {
          try {
            const prompt = await promptsCollection.findOne(
              { _id: new ObjectId(b.promptId) },
              {
                projection: {
                  title: 1,
                  category: 1,
                  aiTool: 1,
                  creatorName: 1,
                },
              },
            );
            return { ...b, prompt };
          } catch {
            return b;
          }
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
      res.json({ success: true, action: "added", result });
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
      res.json({ success: true, result });
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
      res.json({ success: true, result });
    });

    app.get("/api/creator-requests/status", verifyToken, async (req, res) => {
      const request = await creatorRequestsCollection.findOne({
        userEmail: req.user.email,
      });
      res.json({ success: true, request });
    });

    // user profile — fresh from MongoDB
    app.get("/api/users/me", verifyToken, async (req, res) => {
      const user = await userCollection.findOne(
        { _id: req.user._id },
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
      try {
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
      } catch (err) {
        console.error("Stripe error:", err.message);
        res.status(500).json({ message: err.message });
      }
    });

    app.post("/api/payment/success", verifyToken, async (req, res) => {
      const { sessionId } = req.body;
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid")
        return res.status(400).send({ message: "Payment not completed" });
      await userCollection.updateOne(
        { _id: req.user._id },
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
      const users = await userCollection
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
        const result = await userCollection.updateOne(
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
        const result = await userCollection.deleteOne({
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
            $set: { status: "rejected", rejectionFeedback: req.body.feedback },
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
        try {
          const report = await reportsCollection.findOne({
            _id: new ObjectId(req.params.id),
          });
          if (!report)
            return res.status(404).send({ message: "Report not found" });

          let creatorEmail = report.creatorEmail;
          if (!creatorEmail && report.promptId) {
            try {
              const prompt = await promptsCollection.findOne({
                _id: new ObjectId(report.promptId),
              });
              creatorEmail = prompt?.creatorEmail;
            } catch {}
          }

          if (!creatorEmail)
            return res.status(400).send({ message: "Creator not found" });

          await userCollection.updateOne(
            { email: creatorEmail },
            {
              $push: {
                warnings: {
                  reason: report.reason,
                  promptId: report.promptId,
                  date: new Date(),
                },
              },
            },
          );

          const creator = await userCollection.findOne({ email: creatorEmail });
          const warningCount = creator?.warnings?.length || 0;

          if (warningCount >= 3) {
            await userCollection.updateOne(
              { email: creatorEmail },
              { $set: { isSuspended: true } },
            );
            if (report.promptId) {
              try {
                await promptsCollection.deleteOne({
                  _id: new ObjectId(report.promptId),
                });
              } catch {}
            }
          }

          await reportsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { warned: true } },
          );

          res.json({
            success: true,
            message:
              warningCount >= 3
                ? "Creator suspended and prompt removed"
                : "Warning sent",
            suspended: warningCount >= 3,
          });
        } catch (err) {
          console.error("Warn error:", err.message);
          res.status(500).json({ message: err.message });
        }
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
        await userCollection.updateOne(
          { _id: request.userId },
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

    app.get("/api/creator/analytics", verifyToken, async (req, res) => {
      const prompts = await promptsCollection
        .find({ creatorEmail: req.user.email })
        .sort({ createdAt: 1 })
        .toArray();

      const totalPrompts = prompts.length;
      const totalCopies = prompts.reduce(
        (sum, p) => sum + (p.copyCount || 0),
        0,
      );
      const totalBookmarks = await bookmarksCollection.countDocuments({
        promptId: { $in: prompts.map((p) => String(p._id)) },
      });

      const chartData = [];
      for (let i = 5; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const month = date.toLocaleString("en-GB", { month: "short" });
        const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);

        const monthPrompts = prompts.filter((p) => {
          const d = new Date(p.createdAt);
          return d >= monthStart && d < monthEnd;
        });

        const monthCopies = monthPrompts.reduce(
          (sum, p) => sum + (p.copyCount || 0),
          0,
        );

        chartData.push({
          month,
          prompts: monthPrompts.length,
          copies: monthCopies,
        });
      }

      res.json({
        success: true,
        totalPrompts,
        totalCopies,
        totalBookmarks,
        chartData,
      });
    });

    app.get(
      "/api/admin/analytics",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const [totalUsers, totalPrompts, totalReviews, totalCopiesResult] =
          await Promise.all([
            userCollection.countDocuments(),
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
  } finally {
    // await client.close();
  }
}

// Cache the DB connection — only runs once per cold start
let _runPromise = null;
function ensureDB() {
  if (!_runPromise) _runPromise = run();
  return _runPromise;
}

// Block every request until DB is connected and routes are registered
app.use(async (req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database connection failed" });
  }
});

if (require.main === module) {
  app.listen(port, () =>
    console.log(`Promptly server running on port ${port}`),
  );
}

module.exports = app;
