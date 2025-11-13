
import { ApolloServer } from '@apollo/server';
// FIX: Import `ExpressContextFunctionArgument` to correctly type the context creation function.
import { expressMiddleware, ExpressContextFunctionArgument } from '@apollo/server/express4';
// FIX: Import 'express' directly to avoid type conflicts with the global 'Request' type.
import express from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';

// Define required types locally to avoid dependency on the `src` directory.
export enum BookingStatus {
  ACTIVE = 'Active',
  COMPLETED = 'Completed',
  CANCELLED = 'Cancelled'
}

// --- Firebase Admin Initialization ---
if (!admin.apps.length) {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (serviceAccountBase64) {
    try {
      const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } catch (error: any) {
      console.error('Firebase admin initialization error from base64 env var:', error.stack);
    }
  } else {
    // Fallback to previous method for local dev or other setups
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

    if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
      try {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: FIREBASE_PROJECT_ID,
            clientEmail: FIREBASE_CLIENT_EMAIL,
            privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          }),
        });
      } catch (error: any) {
        console.error('Firebase admin initialization error from individual env vars:', error.stack);
      }
    } else {
      console.error('FATAL: Firebase Admin SDK credentials not found. Please set FIREBASE_SERVICE_ACCOUNT_BASE64 or individual FIREBASE_* environment variables in your Vercel project settings.');
    }
  }
}


const adminDb = admin.firestore();
const adminAuth = admin.auth();


// --- GraphQL Schema Definition ---
const typeDefs = `#graphql
  enum Role {
    customer
    operator
    admin
  }

  enum VehicleType {
    TWO_WHEELER
    FOUR_WHEELER
    SUV
  }

  type Vehicle {
    registrationNumber: String!
    type: VehicleType!
  }

  input VehicleInput {
    registrationNumber: String!
    type: VehicleType!
  }

  type User {
    uid: ID!
    name: String
    email: String!
    vehicles: [Vehicle!]
    role: Role!
  }

  type Coordinates {
    lat: Float!
    lng: Float!
  }

  type ParkingSlot {
      id: String!
      status: String!
  }

  type ParkingLot {
    id: ID!
    name: String!
    address: String!
    totalSlots: Int!
    availableSlots: Int!
    pricePerHour: Float!
    coords: Coordinates!
    slots: [ParkingSlot!]!
  }
  
  enum BookingStatus {
    ACTIVE
    COMPLETED
    CANCELLED
  }

  type ParkingLotInfo {
    name: String!
    address: String!
  }

  type Booking {
    id: ID!
    userId: String!
    lotId: String!
    parkingLotInfo: ParkingLotInfo!
    slotNumber: String!
    startTime: String!
    endTime: String!
    durationHours: Int!
    totalAmount: Float!
    status: BookingStatus!
  }

  type AdminStats {
    totalUsers: Int!
    totalLots: Int!
    activeBookings: Int!
    completedBookings: Int!
  }

  type VerifyBookingResponse {
      success: Boolean!
      message: String!
      details: String
  }

  type Query {
    me: User
    parkingLots: [ParkingLot!]!
    myBookings: [Booking!]!
    allUsers: [User!]!
    adminStats: AdminStats!
  }

  type Mutation {
    setupProfile(name: String!, vehicle: VehicleInput!): User!
    addParkingLot(name: String!, address: String!, totalSlots: Int!, pricePerHour: Float!, lat: Float!, lng: Float!, slotPrefix: String!): ParkingLot!
    createBooking(lotId: ID!, slot: String!, duration: Int!): Booking!
    verifyBooking(bookingId: ID!): VerifyBookingResponse!
    updateUserRole(uid: ID!, role: Role!): User!
  }
`;

// --- Type for our Context ---
interface ContextValue {
    user?: {
        uid: string;
        role: string;
        email?: string;
    }
}

// --- GraphQL Resolvers ---
const resolvers = {
    Query: {
        me: async (_: any, __: any, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const doc = await adminDb.collection('users').doc(context.user.uid).get();
            if (!doc.exists) return null;
            return { uid: context.user.uid, ...doc.data() };
        },
        parkingLots: async (_: any, __: any, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const snapshot = await adminDb.collection('parkingLots').get();
            return snapshot.docs.map(doc => {
                const data = doc.data();
                const slots = Object.entries(data.slots || {}).map(([id, status]) => ({ id, status }));
                return { id: doc.id, ...data, slots };
            });
        },
        myBookings: async (_: any, __: any, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const snapshot = await adminDb.collection('bookings').where('userId', '==', context.user.uid).orderBy('startTime', 'desc').get();
            return snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    startTime: data.startTime.toDate().toISOString(),
                    endTime: data.endTime.toDate().toISOString(),
                };
            });
        },
        allUsers: async (_: any, __: any, context: ContextValue) => {
            if (context.user?.role !== 'admin') throw new Error("Forbidden");
            const snapshot = await adminDb.collection('users').get();
            return snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
        },
        adminStats: async (_: any, __: any, context: ContextValue) => {
            if (context.user?.role !== 'admin') throw new Error("Forbidden");
            const [users, lots, active, completed] = await Promise.all([
                adminDb.collection('users').get(),
                adminDb.collection('parkingLots').get(),
                adminDb.collection('bookings').where('status', '==', BookingStatus.ACTIVE).get(),
                adminDb.collection('bookings').where('status', '==', BookingStatus.COMPLETED).get()
            ]);
            return {
                totalUsers: users.size,
                totalLots: lots.size,
                activeBookings: active.size,
                completedBookings: completed.size,
            };
        },
    },
    Mutation: {
        setupProfile: async (_: any, { name, vehicle }: { name: string, vehicle: any }, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const userRef = adminDb.collection('users').doc(context.user.uid);
            
            // Ensure email and a default role are set when creating the profile.
            // This guarantees the document contains all non-nullable fields required by the GraphQL schema.
            const profileData = {
                name,
                vehicles: [vehicle],
                email: context.user.email, // Get email from context
                role: 'customer', // Assign default role
            };

            await userRef.set(profileData, { merge: true });
            
            // The newly created/updated document now contains the email and role.
            const doc = await userRef.get();
            return { uid: context.user.uid, ...doc.data() };
        },
        addParkingLot: async (_: any, args: any, context: ContextValue) => {
             if (context.user?.role !== 'admin' && context.user?.role !== 'operator') throw new Error("Forbidden");
            const { name, address, totalSlots, pricePerHour, lat, lng, slotPrefix } = args;
            const slotsMap: { [key: string]: "available" | "occupied" } = {};
            for (let i = 1; i <= totalSlots; i++) {
                slotsMap[`${slotPrefix}-${i}`] = "available";
            }
            const newLot = { name, address, totalSlots, pricePerHour, coords: { lat, lng }, availableSlots: totalSlots, slots: slotsMap };
            const docRef = await adminDb.collection('parkingLots').add(newLot);
            const slots = Object.entries(slotsMap).map(([id, status]) => ({ id, status }));
            return { id: docRef.id, ...newLot, slots };
        },
        createBooking: async (_: any, { lotId, slot, duration }: {lotId: string, slot: string, duration: number}, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const lotRef = adminDb.collection('parkingLots').doc(lotId);
            const newBookingRef = adminDb.collection('bookings').doc();

            return await adminDb.runTransaction(async (t) => {
                const lotDoc = await t.get(lotRef);
                if (!lotDoc.exists) throw new Error("Parking lot not found.");
                const lotData = lotDoc.data()!;
                if (lotData.slots[slot] !== 'available') throw new Error("Slot is no longer available.");
                
                const startTime = new Date();
                const endTime = new Date(startTime.getTime() + duration * 3600 * 1000);

                const booking = {
                    userId: context.user!.uid, lotId, slotNumber: slot,
                    startTime: admin.firestore.Timestamp.fromDate(startTime),
                    endTime: admin.firestore.Timestamp.fromDate(endTime),
                    durationHours: duration,
                    totalAmount: lotData.pricePerHour * duration,
                    status: BookingStatus.ACTIVE,
                    parkingLotInfo: { name: lotData.name, address: lotData.address },
                };
                t.set(newBookingRef, booking);
                t.update(lotRef, { availableSlots: admin.firestore.FieldValue.increment(-1), [`slots.${slot}`]: 'occupied' });

                return { ...booking, id: newBookingRef.id, startTime: startTime.toISOString(), endTime: endTime.toISOString() };
            });
        },
        verifyBooking: async (_: any, { bookingId }: { bookingId: string }, context: ContextValue) => {
            if (context.user?.role !== 'admin' && context.user?.role !== 'operator') throw new Error("Forbidden");
            const bookingRef = adminDb.collection('bookings').doc(bookingId);
            try {
                 let slotNumber = '';
                 await adminDb.runTransaction(async (t) => {
                    const bookingDoc = await t.get(bookingRef);
                    if (!bookingDoc.exists) throw new Error("Booking not found.");
                    const bookingData = bookingDoc.data()!;
                    if (bookingData.status !== BookingStatus.ACTIVE) throw new Error(`Booking is already ${bookingData.status}.`);
                    
                    slotNumber = bookingData.slotNumber;
                    t.update(bookingRef, { status: BookingStatus.COMPLETED });
                    const lotRef = adminDb.collection('parkingLots').doc(bookingData.lotId);
                    t.update(lotRef, { availableSlots: admin.firestore.FieldValue.increment(1), [`slots.${bookingData.slotNumber}`]: 'available' });
                });
                return { success: true, message: "Check-Out Successful!", details: `Slot ${slotNumber} is now free.` };
            } catch (error: any) {
                return { success: false, message: "Verification Failed", details: error.message };
            }
        },
        updateUserRole: async (_: any, { uid, role }: {uid: string, role: string}, context: ContextValue) => {
            if (context.user?.role !== 'admin') throw new Error("Forbidden");
            if (!['customer', 'operator', 'admin'].includes(role)) throw new Error("Invalid role specified.");

            const userRef = adminDb.collection('users').doc(uid);
            await userRef.update({ role });
            await adminAuth.setCustomUserClaims(uid, { role });
            
            const doc = await userRef.get();
            return { uid, ...doc.data() };
        }
    }
};


// --- Apollo Server Setup with Express ---

const server = new ApolloServer<ContextValue>({
  typeDefs,
  resolvers,
});

// We need to start the server before we can use it
server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();

// Create the express app
const app = express();

// Define the context function for Express
// FIX: Use `ExpressContextFunctionArgument` from `@apollo/server/express4` to ensure the `req` object
// is correctly typed as `express.Request`, resolving type conflicts with the global `Request` type.
const createContext = async ({ req }: ExpressContextFunctionArgument): Promise<ContextValue> => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await adminAuth.verifyIdToken(token);
            const userDoc = await adminDb.collection('users').doc(decodedToken.uid).get();

            // Use the role from the Firestore document as the source of truth for authorization.
            // This ensures that manual DB changes are respected and avoids token staleness issues with custom claims.
            const role = userDoc.exists ? userDoc.data()?.role : 'customer';

            return { user: { 
                uid: decodedToken.uid, 
                role: role || 'customer',
                email: decodedToken.email
            } };
        } catch (error) {
            console.error("Auth token verification failed:", error);
            // Invalid token, proceed without user context
            return {};
        }
    }
    return {};
};

// Setup middleware
// FIX: Explicitly add CORS and JSON body-parsing middleware before Apollo Server.
// This is required by Apollo Server v4 and resolves the 'req.body is not set' error.
// FIX: Combined middleware into a single app.use call to resolve potential overload resolution issues, aligning with Apollo Server documentation.
app.use(
    '/',
    cors(),
    express.json(),
    expressMiddleware(server, {
        context: createContext,
    }),
);

// Vercel will automatically handle routing the request to this express app
export default app;
