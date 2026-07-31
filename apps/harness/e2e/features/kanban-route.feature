Feature: View the work pipeline
  Operators use the home Kanban board to monitor delivery without
  repository management competing with the pipeline.

  Scenario: Home shows add-repo blank slate when no repositories
    Given the Harness has no configured Repositories
    When I open the home page
    Then the add-repository blank slate is visible
    And the kanban board is not rendered

  Scenario: View the empty work pipeline
    Given the Harness has no configured Repositories
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I navigate to the Kanban board
    Then all six pipeline lane headers are visible
    And the Pipeline jobs tab is active
    And repository management is not rendered
    And the committed pull request totals are visible above the board

  Scenario: Switch from Repos to Kanban via top nav
    Given the Harness has no configured Repositories
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    Then the Repos top nav control is active
    And the Kanban top nav control is not active
    When I click the Kanban top nav control
    Then I am on the Kanban board
    And all six pipeline lane headers are visible
    And the Kanban top nav control is active
    And the Repos top nav control is not active

  Scenario: Switch from Kanban to Repos via top nav
    Given the Harness has no configured Repositories
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I navigate to the Kanban board
    Then the Kanban top nav control is active
    And the Repos top nav control is not active
    When I click the Repos top nav control
    Then I am on the Repos page
    And the Repos top nav control is active
    And the Kanban top nav control is not active

  Scenario: Legacy /kanban path lands on the home board
    Given the Harness has no configured Repositories
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I navigate to the legacy Kanban path
    Then I am on the Kanban board
    And the Kanban top nav control is active
