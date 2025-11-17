import { ApolloServer } from '@apollo/server';
import { expressMiddleware, ExpressContextFunctionArgument } from '@apollo/server/express4';
import express from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import crypto from "crypto";

// -------------------- ENUM --------------------
export enum BookingStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'Completed',
  CANCELLED = 'Cancelled',
  PAID = 'PAID'
}

// -------------------- FIREBASE INIT --------------------
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
        console.error('Firebase admin initialization error:', error.stack);
      }
    }
  }
}

const adminDb = admin.firestore();
const adminAuth = admin.auth();

// -------------------- GRAPHQL SCHEMA --------------------
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
    PAID
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

  # Payment Types
  type PaymentOrder {
      orderId: ID!
      amount: Float!
      currency: String!
      bookingId: String!
      status: String!
  }

  type PaymentResult {
      success: Boolean!
      message: String!
      paymentId: String
      orderId: String
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

    # Payment Mock Mutations
    createPaymentOrder(bookingId: ID!): PaymentOrder!
    payOrder(orderId: ID!): PaymentResult!
    verifyPayment(orderId: ID!): PaymentResult!
  }
`;

// -------------------- CONTEXT TYPE --------------------
interface ContextValue {
  user?: {
    uid: string;
    role: string;
    email?: string;
  }
}


// -------------------- RESOLVERS --------------------
const resolvers = {

  Vehicle: {
    type: (parent: { type: string }) => {
      switch (parent.type) {
        case '2-Wheeler': return 'TWO_WHEELER';
        case '4-Wheeler': return 'FOUR_WHEELER';
        default: return parent.type;
      }
    },
  },

  Query: {
    me: async (_: any, __: any, context: ContextValue) => {
      if (!context.user) throw new Error("Unauthorized");
      const doc = await adminDb.collection('users').doc(context.user.uid).get();
      if (!doc.exists) return null;
      const data = doc.data()!;
      return { uid: context.user.uid, ...data, role: data.role || 'customer' };
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
      const snapshot = await adminDb
        .collection('bookings')
        .where('userId', '==', context.user.uid)
        .orderBy('startTime', 'desc')
        .get();

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
      return snapshot.docs.map(doc => {
        const data = doc.data();
        return { uid: doc.id, ...data, role: data.role || 'customer' };
      });
    },

    adminStats: async (_: any, __: any, context: ContextValue) => {
      if (context.user?.role !== 'admin') throw new Error("Forbidden");

      const [users, lots, active, completed] = await Promise.all([
        adminDb.collection('users').get(),
        adminDb.collection('parkingLots').get(),
        adminDb.collection('bookings').where('status', '==', BookingStatus.ACTIVE).get(),
        adminDb.collection('bookings').where('status', '==', BookingStatus.COMPLETED).get(),
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

    // -------------------- PROFILE --------------------
    setupProfile: async (_: any, { name, vehicle }: any, context: ContextValue) => {
      if (!context.user) throw new Error("Unauthorized");

      const userRef = adminDb.collection('users').doc(context.user.uid);

      await userRef.set({
        name,
        vehicles: [vehicle],
        email: context.user.email,
        role: "customer"
      }, { merge: true });

      const doc = await userRef.get();
      return { uid: context.user.uid, ...doc.data() };
    },

    // -------------------- ADD PARKING LOT --------------------
    addParkingLot: async (_: any, args: any, context: ContextValue) => {
      if (context.user?.role !== 'admin' && context.user?.role !== 'operator')
        throw new Error("Forbidden");

      const { name, address, totalSlots, pricePerHour, lat, lng, slotPrefix } = args;

      const slotsMap: any = {};
      for (let i = 1; i <= totalSlots; i++) {
        slotsMap[`${slotPrefix}-${i}`] = "available";
      }

      const newLot = {
        name,
        address,
        totalSlots,
        pricePerHour,
        coords: { lat, lng },
        availableSlots: totalSlots,
        slots: slotsMap,
      };

      const docRef = await adminDb.collection('parkingLots').add(newLot);
      const slots = Object.entries(slotsMap).map(([id, status]) => ({ id, status }));

      return { id: docRef.id, ...newLot, slots };
    },

    // -------------------- CREATE BOOKING --------------------
    createBooking: async (_: any, { lotId, slot, duration }: any, context: ContextValue) => {
      if (!context.user) throw new Error("Unauthorized");

      const lotRef = adminDb.collection('parkingLots').doc(lotId);
      const newBookingRef = adminDb.collection('bookings').doc();

      return await adminDb.runTransaction(async (t) => {
        const lotDoc = await t.get(lotRef);
        if (!lotDoc.exists) throw new Error("Parking lot not found.");

        const lotData = lotDoc.data()!;
        if (lotData.slots[slot] !== 'available')
          throw new Error("Slot is no longer available.");

        const startTime = new Date();
        const endTime = new Date(startTime.getTime() + duration * 3600 * 1000);

        const booking = {
          userId: context.user!.uid,
          lotId,
          slotNumber: slot,
          startTime: admin.firestore.Timestamp.fromDate(startTime),
          endTime: admin.firestore.Timestamp.fromDate(endTime),
          durationHours: duration,
          totalAmount: lotData.pricePerHour * duration,
          status: BookingStatus.ACTIVE,
          parkingLotInfo: { name: lotData.name, address: lotData.address },
        };

        t.set(newBookingRef, booking);
        t.update(lotRef, {
          availableSlots: admin.firestore.FieldValue.increment(-1),
          [`slots.${slot}`]: 'occupied'
        });

        return {
          ...booking,
          id: newBookingRef.id,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString()
        };
      });
    },

    // -------------------- MOCK PAYMENT: CREATE ORDER --------------------
    createPaymentOrder: async (_: any, { bookingId }: any, context: ContextValue) => {
      if (!context.user) throw new Error("Unauthorized");

      const bookingDoc = await adminDb.collection("bookings").doc(bookingId).get();
      if (!bookingDoc.exists) throw new Error("Booking not found");

      const bookingData = bookingDoc.data()!;
      const fakeOrderId = "mock_order_" + crypto.randomBytes(8).toString("hex");

      const paymentOrder = {
        orderId: fakeOrderId,
        bookingId,
        amount: bookingData.totalAmount,
        currency: "INR",
        status: "PENDING",
        userId: context.user.uid,
        createdAt: new Date().toISOString(),
      };

      await adminDb.collection("payments").doc(fakeOrderId).set(paymentOrder);
      return paymentOrder;
    },

    // -------------------- MOCK PAYMENT: PAY ORDER --------------------
    payOrder: async (_: any, { orderId }: any, context: ContextValue) => {
      if (!context.user) throw new Error("Unauthorized");

      const paymentRef = adminDb.collection("payments").doc(orderId);
      const paymentDoc = await paymentRef.get();

      if (!paymentDoc.exists) throw new Error("Order not found");

      await new Promise(r => setTimeout(r, 1500));

      const success = Math.random() > 0.1; // 90% success
      const paymentId = "mock_payment_" + crypto.randomBytes(8).toString("hex");

      await paymentRef.update({
        status: success ? "PAID" : "FAILED",
        paymentId,
        paidAt: success ? new Date().toISOString() : null
      });

      return {
        success,
        message: success ? "Payment Successful" : "Payment Failed",
        paymentId: success ? paymentId : null,
        orderId
      };
    },

    // -------------------- MOCK PAYMENT: VERIFY --------------------
    verifyPayment: async (_: any, { orderId }: any, context: ContextValue) => {
      if (!context.user) throw new Error("Unauthorized");

      const paymentDoc = await adminDb.collection("payments").doc(orderId).get();
      if (!paymentDoc.exists) throw new Error("Order not found");

      const data = paymentDoc.data()!;
      if (data.status !== "PAID") {
        return { success: false, message: "Payment not completed", orderId };
      }

      await adminDb.collection("bookings")
        .doc(data.bookingId)
        .update({ status: "PAID" });

      return {
        success: true,
        message: "Payment Verified Successfully",
        orderId
      };
    },

    // -------------------- UPDATE USER ROLE --------------------
    updateUserRole: async (_: any, { uid, role }: any, context: ContextValue) => {
      if (context.user?.role !== 'admin') throw new Error("Forbidden");
      await adminDb.collection('users').doc(uid).update({ role });
      return { uid, role };
    }

  }
};


// -------------------- APOLLO SERVER SETUP --------------------
const server = new ApolloServer<ContextValue>({
  typeDefs,
  resolvers,
});

server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();

const app = express();

// -------------------- CONTEXT --------------------
const createContext = async ({ req }: ExpressContextFunctionArgument): Promise<ContextValue> => {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split("Bearer ")[1];

    try {
      const decoded = await adminAuth.verifyIdToken(token);
      const userDoc = await adminDb.collection("users").doc(decoded.uid).get();

      return {
        user: {
          uid: decoded.uid,
          role: userDoc.exists ? userDoc.data()?.role : "customer",
          email: decoded.email
        }
      };
    } catch (err) {
      return {};
    }
  }

  return {};
};


// -------------------- MIDDLEWARE --------------------
app.use(cors());
app.use(express.json());
app.use("/", expressMiddleware(server, { context: createContext }));


// -------------------- EXPORT --------------------
export default app;
