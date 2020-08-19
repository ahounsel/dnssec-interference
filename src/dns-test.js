/* global browser */ 
const DNS_PACKET = require("dns-packet");
const { v4: uuidv4 } = require("uuid");

const APEX_DOMAIN_NAME = "dnssec-experiment-moz.net";
const SMIMEA_DOMAIN_NAME = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2a._smimecert.dnssec-experiment-moz.net";
const HTTPS_DOMAIN_NAME = "dnssec-experiment-moz.net";

const RRTYPES = ['A', 'RRSIG', 'DNSKEY', 'SMIMEA', 'HTTPS', 'NEWONE', 'NEWTWO'];
const RESOLVCONF_ATTEMPTS = 2; // Number of UDP attempts per nameserver. We let TCP handle re-transmissions on its own.

const STUDY_START = "STUDY_START";
const STUDY_MEASUREMENT_COMPLETED = "STUDY_MEASUREMENT_COMPLETED";
const STUDY_ERROR_UDP_MISC = "STUDY_ERROR_UDP_MISC";
const STUDY_ERROR_TCP_MISC = "STUDY_ERROR_TCP_MISC";
const STUDY_ERROR_UDP_ENCODE = "STUDY_ERROR_UDP_ENCODE";
const STUDY_ERROR_TCP_ENCODE = "STUDY_ERROR_TCP_ENCODE";
const STUDY_ERROR_NAMESERVERS_OS_NOT_SUPPORTED = "STUDY_ERROR_NAMESERVERS_OS_NOT_SUPPORTED";
const STUDY_ERROR_NAMESERVERS_NOT_FOUND = "STUDY_ERROR_NAMESERVERS_NOT_FOUND";
const STUDY_ERROR_NAMESERVERS_MISC = "STUDY_ERROR_NAMESERVERS_MISC";

const TELEMETRY_TYPE = "dnssec-study-v1";
const TELEMETRY_OPTIONS = {
    addClientId: true,
    addEnvironment: true
};

const MAX_TXID = 65535;
const MIN_TXID = 0;

const UDP_PAYLOAD_SIZE = 4096;

var measurementID;

var dnsData = {
    udpA:      [],
    udpADO:    [],
    udpRRSIG:  [],
    udpDNSKEY: [],
    udpSMIMEA: [],
    udpHTTPS:  [],
    udpNEWONE: [],
    udpNEWTWO: [],
    tcpA:      [],
    tcpADO:    [],
    tcpRRSIG:  [],
    tcpDNSKEY: [],
    tcpSMIMEA: [],
    tcpHTTPS:  [],
    tcpNEWONE: [],
    tcpNEWTWO: []
};

var dnsAttempts = {
    udpA:      0,
    udpADO:    0,
    udpRRSIG:  0,
    udpDNSKEY: 0,
    udpSMIMEA: 0,
    udpHTTPS:  0,
    udpNEWONE: 0,
    udpNEWTWO: 0,
    tcpA:      0,
    tcpADO:    0,
    tcpRRSIG:  0,
    tcpDNSKEY: 0,
    tcpSMIMEA: 0,
    tcpHTTPS:  0,
    tcpNEWONE: 0,
    tcpNEWTWO: 0 
};

/**
 * Encode a DNS query to be sent over a UDP socket
 */
function encodeUDPQuery(domain, rrtype, dnssec_ok) {
    let buf;
    if (dnssec_ok) {
        buf = DNS_PACKET.encode({
            type: 'query',
            // Generate a random transaction ID between 0 and 65535
            id: Math.floor(Math.random() * (MAX_TXID - MIN_TXID + 1)) + MIN_TXID,
            flags: DNS_PACKET.RECURSION_DESIRED,
            questions: [{ type: rrtype, name: domain }],
            additionals: [{ type: 'OPT', name: '.', udpPayloadSize: UDP_PAYLOAD_SIZE, flags: DNS_PACKET.DNSSEC_OK }]
        });
    } else {
        buf = DNS_PACKET.encode({
            type: 'query',
            // Generate a random transaction ID between 0 and 65535
            id: Math.floor(Math.random() * (MAX_TXID - MIN_TXID + 1)) + MIN_TXID,
            flags: DNS_PACKET.RECURSION_DESIRED,
            questions: [{ type: rrtype, name: domain }],
            additionals: [{ type: 'OPT', name: '.', udpPayloadSize: UDP_PAYLOAD_SIZE }]
        });
    }
    return buf
}

/**
 * Encode a DNS query to be sent over a TCP socket
 */
function encodeTCPQuery(domain, rrtype, dnssec_ok) {
    let buf;
    if (dnssec_ok) {
        buf = DNS_PACKET.streamEncode({
            type: 'query',
            // Generate a random transaction ID between 0 and 65535
            id: Math.floor(Math.random() * (MAX_TXID - MIN_TXID + 1)) + MIN_TXID,
            flags: DNS_PACKET.RECURSION_DESIRED,
            questions: [{ type: rrtype, name: domain }],
            additionals: [{ type: 'OPT', name: '.', flags: DNS_PACKET.DNSSEC_OK }]
        });
    } else {
        buf = DNS_PACKET.streamEncode({
            type: 'query',
            // Generate a random transaction ID between 0 and 65535
            id: Math.floor(Math.random() * (MAX_TXID - MIN_TXID + 1)) + MIN_TXID,
            flags: DNS_PACKET.RECURSION_DESIRED,
            questions: [{ type: rrtype, name: domain }]
        });
    }
    return buf;
}

/**
 * Send a DNS query over UDP, re-transmitting according to default 
 * resolvconf behavior if we fail to receive a response.
 *
 * In short, we re-transmit at most RESOLVCONF_ATTEMPTS for each nameserver 
 * we find. The timeout for each missing response is RESOLVCONF_TIMEOUT 
 * (5000 ms).
 */
async function sendUDPQuery(domain, nameservers, rrtype, dnssec_ok) {
    let queryBuf;
    try {
        queryBuf = encodeUDPQuery(domain, rrtype, dnssec_ok);
    } catch(e) {
        sendTelemetry({reason: STUDY_ERROR_UDP_ENCODE});
        throw new Error(STUDY_ERROR_UDP_ENCODE);
    }

    let key;
    let errorKey;
    if (dnssec_ok) {
        key = "udp" + rrtype + "DO"; 
        errorKey = rrtype + "DO";
    } else {
        key = "udp" + rrtype;
        errorKey = rrtype;
    }

    for (let i = 1; i <= RESOLVCONF_ATTEMPTS; i++) {
        for (let nameserver of nameservers) {
            try {
                dnsAttempts[key] += 1
                let responseBytes = await browser.experiments.udpsocket.sendDNSQuery(nameserver, queryBuf, rrtype);

                // If we don't already have a response saved in dnsData, save this one
                if (dnsData[key].length == 0) {
                    dnsData[key] = Array.from(responseBytes);
                }
                // If we didn't get an error, return.
                // We don't need to re-transmit.
                return;
            } catch(e) {
                let errorReason;
                if (e.message.startsWith("STUDY_ERROR_UDP")) {
                    errorReason = e.message;
                } else {
                    errorReason = STUDY_ERROR_UDP_MISC;
                }
                sendTelemetry({reason: errorReason,
                               errorRRTYPE: errorKey,
                               errorAttempt: dnsAttempts[key]});
            }
        }
    }
}

/**
 * Send a DNS query over TCP, re-transmitting to another nameserver if we 
 * fail to receive a response. We let TCP handle re-transmissions.
 */
async function sendTCPQuery(domain, nameservers, rrtype, dnssec_ok) {
    let queryBuf;
    try {
        queryBuf = encodeTCPQuery(domain, rrtype, dnssec_ok);
    } catch(e) {
        sendTelemetry({reason: STUDY_ERROR_TCP_ENCODE});
        throw new Error(STUDY_ERROR_TCP_ENCODE);
    }

    let key;
    let errorKey;
    if (dnssec_ok) {
        key = "tcp" + rrtype + "DO"; 
        errorKey = rrtype + "DO";
    } else {
        key = "tcp" + rrtype;
        errorKey = rrtype;
    }

    for (let nameserver of nameservers) {
        try {
            dnsAttempts[key] += 1;
            let responseBytes = await browser.experiments.tcpsocket.sendDNSQuery(nameserver, queryBuf);

            // If we don't already have a response saved in dnsData, save this one
            if (dnsData[key].length == 0) {
                dnsData[key] = Array.from(responseBytes);
            }
            // If we didn't get an error, return.
            // We don't need to re-transmit.
            return;
        } catch (e) {
            let errorReason;
            if (e.message.startsWith("STUDY_ERROR_TCP")) {
                errorReason = e.message;
            } else {
                errorReason = STUDY_ERROR_TCP_MISC;
            }
            sendTelemetry({reason: errorReason,
                           errorRRTYPE: errorKey,
                           errorAttempt: dnsAttempts[key]});

        }
    }
}

/**
 * Read the client's nameservers from disk.
 * If on macOS, read /etc/resolv.comf.
 * If on Windows, read a registry.
 */
async function readNameservers() {
    let nameservers = [];
    try { 
        let platform = await browser.runtime.getPlatformInfo();
        if (platform.os == "mac") {
            nameservers = await browser.experiments.resolvconf.readNameserversMac();
        } else if (platform.os == "win") {
            nameservers = await browser.experiments.resolvconf.readNameserversWin();
        } else {
            throw new Error(STUDY_ERROR_NAMESERVERS_OS_NOT_SUPPORTED);
        }
    } catch(e) {
        let errorReason;
        if (e.message.startsWith("STUDY_ERROR_NAMESERVERS")) {
            errorReason = e.message;
        } else {
            errorReason = STUDY_ERROR_NAMESERVERS_MISC;
        }
        sendTelemetry({reason: errorReason});
        throw new Error(errorReason);
    }

    if (!(nameservers && nameservers.length)) {
        sendTelemetry({reason: STUDY_ERROR_NAMESERVERS_NOT_FOUND});
        throw new Error(STUDY_ERROR_NAMESERVERS_NOT_FOUND);
    }
    return nameservers;
}

/**
 * For each RR type that we have a DNS record for, attempt to send queries over 
 * UDP and TCP.
 */
async function sendQueries(nameservers_ipv4) {
    for (let rrtype of RRTYPES) {
        if (rrtype == 'SMIMEA') {
            await sendUDPQuery(SMIMEA_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
            await sendTCPQuery(SMIMEA_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
        } else if (rrtype == 'HTTPS') {
            await sendUDPQuery(HTTPS_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
            await sendTCPQuery(HTTPS_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
        } else if (rrtype == 'A') {
            // First send queries with the DNSSEC OK bit, then without
            await sendUDPQuery(APEX_DOMAIN_NAME, nameservers_ipv4, rrtype, true);
            await sendTCPQuery(APEX_DOMAIN_NAME, nameservers_ipv4, rrtype, true);
            await sendUDPQuery(APEX_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
            await sendTCPQuery(APEX_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
        } else {
            await sendUDPQuery(APEX_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
            await sendTCPQuery(APEX_DOMAIN_NAME, nameservers_ipv4, rrtype, false);
        }
    }
}

/**
 * Add an ID to telemetry that corresponds with this instance of our
 * measurement, i.e. a browser session
 */
function sendTelemetry(payload) {
    payload.measurementID = measurementID;
    browser.telemetry.submitPing(TELEMETRY_TYPE, payload, TELEMETRY_OPTIONS);
}

/**
 * Entry point for our measurements.
 */
async function runMeasurement() {
    // If we can't upload telemetry. don't run the addon
    let canUpload = await browser.telemetry.canUpload();
    if (!canUpload) {
        return
    }

    // Send a ping to indicate the start of the measurement
    measurementID = uuidv4();
    sendTelemetry({reason: STUDY_START});

    let nameservers_ipv4 = await readNameservers();
    await sendQueries(nameservers_ipv4);

    // Mark the end of the measurement by sending the DNS responses to telemetry
    let payload = {reason: STUDY_MEASUREMENT_COMPLETED};
    payload.dnsData = dnsData;
    payload.dnsAttempts = dnsAttempts;
    sendTelemetry(payload);
}

runMeasurement();
