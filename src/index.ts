import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v2";
import axios from "axios";
import cors from "cors";

// Initialize Firebase Admin SDK
const serviceAccount = require("/etc/secrets/test-e1389-firebase-adminsdk-fbsvc-5bb03be7b2.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });  // This handles undefined values
const app = express();
const port = 3001;

// Enable CORS
app.use(cors());
app.use(bodyParser.json());

// Problem model
interface Problem {
  chefId: string;
  description: string;
  type: string;
  status: "waiting" | "progressing" | "solved";
  createdAt: FirebaseFirestore.FieldValue;
  isPredefined: boolean; // New field to identify predefined problems
  assignedTechnician?: string | null; // Optional field for the assigned technician
  solvedAt?: FirebaseFirestore.FieldValue; // Optional field for solved timestamp
}

// Predefined Problem model
interface PredefinedProblem {
  title: string;
  type: string;
  description: string;
}

// Create a regular problem (isPredefined = false)

app.post("/problems", async (req, res) => {
  try {
    const { chefId, title, description, type } = req.body;

    // 1. Find available technicians with matching specialty
    const techniciansSnapshot = await db.collection("users")
      .where("role", "==", "technicien")
      .where("speciality", "==", type)
      .where("isAvailable", "==", true)
      .get();

    let assignedTechnicianId = null;
    let minWorkload = Infinity;

    // 2. Select technician with fewest problems
    techniciansSnapshot.forEach(doc => {
      const currentProblems = doc.data().allProblems?.length || 0;
      if (currentProblems < minWorkload) {
        minWorkload = currentProblems;
        assignedTechnicianId = doc.id;
      }
    });

    // 3. Create problem
    const newProblem = {
      chefId,
      description: description || title,
      type,
      status: "waiting",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isPredefined: false,
      assignedTechnician: assignedTechnicianId,
    };

    const problemRef = await db.collection("problems").add(newProblem);
    const problemId = problemRef.id;

    // 4. Update technician
    if (assignedTechnicianId) {
      const techRef = db.collection("users").doc(assignedTechnicianId);
      const techDoc = await techRef.get();
      const techData = techDoc.data();

      const updates = {
        allProblems: admin.firestore.FieldValue.arrayUnion(problemId),
        currentProblem: problemId,
        lastAssigned: admin.firestore.FieldValue.serverTimestamp(),
        isAvailable: ((techData?.allProblems?.length || 0) + 1) < 3,
      };

      await techRef.update(updates);

      // 5. Send email via Notification Microservice
      const technicianEmail = techData?.email;
      if (technicianEmail) {
        try {
          await axios.post("http://localhost:8000/notify/email", {
            to: technicianEmail,
            subject: "New Problem Assigned",
            body: `You have been assigned a new problem: ${description || title}`,
          });
        } catch (emailError: unknown) {
          if (emailError instanceof Error) {
            console.error("Email sending failed:", emailError.message);
          } else {
            console.error("Email sending failed with unknown error:", emailError);
          }
        }
      }
    }

    res.status(201).json({
      id: problemId,
      assignedTo: assignedTechnicianId || "no available technician",
      currentWorkload: minWorkload !== Infinity ? minWorkload : "N/A",
      message: assignedTechnicianId
        ? `Assigned to technician with ${minWorkload} existing problems`
        : "No available technicians found",
    });

  } catch (error) {
    console.error("Error creating problem:", error);
    res.status(500).json({ error: "Failed to create problem" });
  }
});
// Create a predefined problem (no automatic assignment)
app.post("/problems/predefined", async (req: Request, res: Response) => {
  try {
    const { title, type, description } = req.body;
    
    const newProblem: Problem = {
      chefId: "system",
      description: description || title,
      type,
      status: "waiting", // Status remains waiting
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isPredefined: true,
      assignedTechnician: null
    };

    const problemRef = await db.collection("problems").add(newProblem);
    
    res.status(201).json({ 
      id: problemRef.id, 
      message: "Predefined problem created successfully",
      assignedTechnician: null,
      status: "waiting" // Explicitly return status
    });
  } catch (error) {
    console.error("Error creating predefined problem:", error);
    res.status(500).json({ error: "Failed to create predefined problem" });
  }
});

// Get all predefined problems
app.get("/problems/predefined", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("problems")
      .where("isPredefined", "==", true)
      .get();
    const problems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(problems);
  } catch (error) {
    console.error("Error fetching predefined problems:", error);
    res.status(500).json({ error: "Failed to fetch predefined problems" });
  }
});

// Get all regular problems
app.get("/problems/regular", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("problems")
      .where("isPredefined", "==", false)
      .get();
    const problems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(problems);
  } catch (error) {
    console.error("Error fetching regular problems:", error);
    res.status(500).json({ error: "Failed to fetch regular problems" });
  }
});

// Get problems filtered by chefId
// Update the GET /problems endpoint to support assignedTechnician filter
app.get("/problems", async (req: Request, res: Response) => {
  try {
    const { chefId, assignedTechnician } = req.query;

    let query: FirebaseFirestore.Query = db.collection("problems");

    // Apply filters if provided
    if (chefId) {
      query = query.where("chefId", "==", chefId);
    }
    if (assignedTechnician) {
      query = query.where("assignedTechnician", "==", assignedTechnician);
    }

    const problemsSnapshot = await query.get();
    const problems = problemsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(problems);
  } catch (error) {
    console.error("Error fetching problems:", error);
    res.status(500).json({ error: "Failed to fetch problems" });
  }
});

// Get a problem by ID
app.get("/problems/:id", async (req: Request, res: Response) => {
  try {
    const problemRef = db.collection("problems").doc(req.params.id);
    const problemDoc = await problemRef.get();
    if (!problemDoc.exists) {
      res.status(404).json({ error: "Problem not found" });
    } else {
      res.status(200).json({ id: problemDoc.id, ...problemDoc.data() });
    }
  } catch (error) {
    console.error("Error fetching problem:", error);
    res.status(500).json({ error: "Failed to fetch problem" });
  }
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Update problem status
app.put("/problems/:id", async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const problemId = req.params.id;
    const problemRef = db.collection("problems").doc(problemId);

    const problemDoc = await problemRef.get();
    const problemData = problemDoc.data();
    const assignedTechnicianId = problemData?.assignedTechnician;

    const updateData: any = { status };
    if (status === "solved") {
      updateData.solvedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await problemRef.update(updateData);

    if (status === "solved" && assignedTechnicianId) {
      try {
        const techRef = db.collection("users").doc(assignedTechnicianId);
        const techDoc = await techRef.get();

        if (techDoc.exists) {
          await axios.put(`http://localhost:3000/users/${assignedTechnicianId}/availability`, {
            isAvailable: true,
            currentProblem: null
          });
        }
      } catch (error) {
        console.error("Error updating technician availability:", error);
      }
    }

    res.status(200).json({
      message: "Problem status updated successfully",
      technicianUpdated: status === "solved" && !!assignedTechnicianId
    });
  } catch (error) {
    console.error("Error updating problem:", error);
    res.status(500).json({ error: "Failed to update problem" });
  }
});


// Delete a problem
app.delete("/problems/:id", async (req: Request, res: Response) => {
  try {
    await db.collection("problems").doc(req.params.id).delete();
    res.status(200).json({ message: "Problem deleted successfully" });
  } catch (error) {
    console.error("Error deleting problem:", error);
    res.status(500).json({ error: "Failed to delete problem" });
  }
});


// Firestore Trigger: Automatically assign a technician to a new problem
// Modify your Firestore trigger to skip assignment for predefined problems
export const assignTechnicianToProblem = functions.firestore.onDocumentCreated(
  "problems/{problemId}",
  async (event) => {
    const snapshot = event.data;
    const context = event.params;
    if (!snapshot) {
      console.error("Snapshot is undefined");
      return;
    }

    const problemData = snapshot.data();
    
    // Skip if it's a predefined problem (they might not need assignment)
    if (problemData.isPredefined) {
      console.log("Skipping technician assignment for predefined problem");
      return;
    }

    const problemType = problemData.type;
    const problemId = context.problemId;

    try {
      // Rest of your existing assignment logic...
      const techniciansSnapshot = await db
        .collection("users")
        .where("role", "==", "technicien")
        .where("speciality", "==", problemType)
        .limit(1)
        .get();

      if (techniciansSnapshot.empty) {
        console.log(`No technician found for problem type: ${problemType}`);
        return;
      }

      const technicianId = techniciansSnapshot.docs[0].id;
      await db.collection("problems").doc(problemId).update({
        assignedTechnician: technicianId
      });

      console.log(`Assigned technician ${technicianId} to problem ${problemId}`);
    } catch (error) {
      console.error("Error assigning technician:", error);
    }
  }
);
// Start the server
app.listen(port, () => {
  console.log(`Problem Service running on http://localhost:${port}`);
});
