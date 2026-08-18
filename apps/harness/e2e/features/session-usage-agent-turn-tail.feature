@ui-history
Feature: Session usage Agent Turn Tail
  Opening Session usage from a Session ID stays cheap: token usage loads
  without the tail. Show tail then Refresh peek the latest OpenCode Agent
  Turn. An idle canonical Session shows the Jump hint. Close forgets the peek
  (issue #1144).

  Background:
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model

  Scenario: Clicking a Session ID opens token usage without fetching the tail
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Session usage for the idle OpenCode Session from Pipeline
    Then the Session usage dialog is visible
    And the Session usage dialog shows successful Session Telemetry fields
    And the Session usage dialog shows Show tail
    And the Session usage dialog does not show Agent Turn Tail

  Scenario: Show tail then Refresh shows the empty OpenCode Jump hint
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Session usage for the idle OpenCode Session from Pipeline
    And I show the Agent Turn Tail
    Then the Session usage dialog shows the empty Jump hint
    When I refresh the Agent Turn Tail
    Then the Session usage dialog shows the empty Jump hint

  Scenario: Closing Session usage forgets the tail peek
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Session usage for the idle OpenCode Session from Pipeline
    And I show the Agent Turn Tail
    Then the Session usage dialog shows the empty Jump hint
    When I close the Session usage dialog
    And I open Session usage for the idle OpenCode Session from Pipeline
    Then the Session usage dialog shows successful Session Telemetry fields
    And the Session usage dialog shows Show tail
    And the Session usage dialog does not show Agent Turn Tail

  Scenario: Show tail is hidden when the Agent Backend cannot serve a tail
    When I open Session usage for a Session whose Agent Backend cannot serve a tail
    Then the Session usage dialog is visible
    And the Session usage dialog does not show Show tail
