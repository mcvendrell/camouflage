import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import Handlebars from "handlebars";
import logger from "../logger";
let DELAY: number = 0;
/**
 * Create a parser class which defines methods to parse
 * 1. Request URL to get a matching directory
 * 2. From matched directory get .mock file content and generate a response
 * @param {express.Request} req Express Request object used to perform request url parsing
 * @param {string} mockDir Location of all mocks
 * @param {express.Response} res Express response to send the parsed response body and headers to client
 */
export class Parser {
  private req: express.Request;
  private mockDir: string;
  private res: express.Response;
  constructor(req: express.Request, res: express.Response, mockDir: string) {
    this.req = req;
    this.mockDir = mockDir;
    this.res = res;
  }
  getMatchedDir = () => {
    const reqDetails = {
      method: this.req.method.toUpperCase(),
      path: this.req.path,
      protocol: this.req.protocol,
      httpVersion: this.req.httpVersion,
      query: this.req.query,
      headers: this.req.headers,
      body: this.req.body,
    };
    const matchedDir = getWildcardPath(reqDetails.path, this.mockDir);
    return matchedDir;
  };

  getResponse = (mockFile: string) => {
    /**
     * Since response file contains headers and body both, a PARSE_BODY flag is required
     * to tell the logic if it's currently parsing headers or body
     * Set responseBody to an empty string and set a default response object
     */
    let PARSE_BODY = false;
    let responseBody = "";
    let response = {
      status: 404,
      body: '{"error": "Not Found"}',
      headers: {
        "content-type": "application/json",
      },
    };
    // Check if mock file exists
    if (fs.existsSync(mockFile)) {
      // Compile the handlebars used in the contents of mockFile
      const template = Handlebars.compile(fs.readFileSync(mockFile).toString());
      // Generate actual response i.e. replace handlebars with their actual values and split the content into lines
      const fileContent = template({ request: this.req }).split(os.EOL);
      //Read file line by line
      fileContent.forEach((line, index) => {
        /**
         * Set PARSE_BODY flag to try when reader finds a blank line,
         * since according to standard format of a raw HTTP Response,
         * headers and body are separated by a blank line.
         */
        if (line === "") {
          PARSE_BODY = true;
        }
        //If line includes HTTP/HTTPS i.e. first line. Get the response status code
        if (line.includes("HTTP")) {
          const regex = /(?<=HTTP\/\d).*?\s+(\d{3,3})/i;
          if (!regex.test(line)) {
            logger.error("Response code should be valid string");
            throw new Error("Response code should be valid string");
          }
          response.status = <number>(<unknown>line.match(regex)[1]);
          logger.debug("Response Status set to " + response.status);
        } else {
          /**
           * If following conditions are met:
           *      Line is not blank
           *      And parser is not currently parsing response body yet i.e. PARSE_BODY === false
           * Then:
           *      Split line by :, of which first part will be header key and 2nd part will be header value
           *      If headerKey is response delay, set variable DELAY to headerValue
           */
          if (line !== "" && !PARSE_BODY) {
            let headerKey = line.split(":")[0];
            let headerValue = line.split(":")[1];
            if (headerKey === "Response-Delay") {
              DELAY = <number>(<unknown>headerValue);
              logger.debug(`Delay Set ${headerValue}`);
            } else {
              this.res.setHeader(headerKey, headerValue);
              logger.debug(`Headers Set ${headerKey}: ${headerKey}`);
            }
          }
        }
        // If parsing response body. Concatenate every line till last line to a responseBody variable
        if (PARSE_BODY) {
          responseBody = responseBody + line;
        }
        /**
         * If on last line, do following:
         *    Trim and remove whitespaces from the responseBody
         *    Compile the Handlebars to generate a final response
         *    Set PARSE_BODY flag back to false and responseBody to blank
         *    Set express.Response Status code to response.status
         *    Send the generated Response, from a timeout set to send the response after a DELAY value
         */
        if (index == fileContent.length - 1) {
          responseBody = responseBody.replace(/\s+/g, " ").trim();
          responseBody = responseBody.replace(/{{{/, "{ {{");
          responseBody = responseBody.replace(/}}}/, "}} }");
          const template = Handlebars.compile(responseBody);
          PARSE_BODY = false;
          responseBody = "";
          this.res.statusCode = response.status;
          setTimeout(() => {
            logger.debug(`Generated Response ${template({ request: this.req })}`);
            this.res.send(template({ request: this.req }));
          }, DELAY);
          DELAY = 0;
        }
      });
    } else {
      logger.error(`No suitable mock file found: ${mockFile}. Sending default response.`);
      //If no mockFile is found, return default response
      this.res.statusCode = response.status;
      let headerKeys = Object.keys(response.headers);
      headerKeys.forEach((headerKey) => {
        // @ts-ignore
        res.setHeader(headerKey, response.headers[headerKey]);
      });
      this.res.send(response.body);
    }
  };
}

const removeBlanks = (array: Array<any>) => {
  return array.filter(function (i) {
    return i;
  });
};
const getWildcardPath = (dir: string, mockDir: string) => {
  let steps = removeBlanks(dir.split("/"));
  let testPath;
  let newPath = path.join(mockDir, steps.join("/"));
  let exists = false;

  while (steps.length) {
    steps.pop();
    testPath = path.join(mockDir, steps.join("/"), "__");
    exists = fs.existsSync(testPath);
    if (exists) {
      newPath = testPath;
      break;
    }
  }
  return newPath;
};
